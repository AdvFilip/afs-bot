const express = require("express");
const fs = require("fs");
const path = require("path");
const { createClient } = require("@supabase/supabase-js");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState
} = require("@whiskeysockets/baileys");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// ===== ENV =====
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const PRIMARY_PROVIDER = (process.env.PRIMARY_PROVIDER || "baileys").toLowerCase();
const SECONDARY_PROVIDER = (process.env.SECONDARY_PROVIDER || "meta").toLowerCase();
const SCAN_INTERVAL_MS = Number(process.env.SCAN_INTERVAL_MS || 10000);
const MAX_BATCH = Number(process.env.MAX_BATCH || 20);

// local runtime path inside container (ephemeral, but synced to DB)
const WA_AUTH_PATH = process.env.WA_AUTH_PATH || "./wa_auth_runtime";
const WA_AUTH_ROW_ID = "default";

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ===== WA Globals =====
let waSock = null;
let waReady = false;
let latestQrText = null;
let latestQrDataUrl = null;
let lastWaError = null;
let waConnectedAt = null;

// ===== Helpers =====
function isValidE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}
function normalizeToWaJid(phone) {
  return `${phone.replace(/[^\d]/g, "")}@s.whatsapp.net`;
}
function formatMessage(reminder) {
  return `⚖️ AFS Legal Reminder\n\nReminder: ${reminder.title}\nTime: ${reminder.scheduled_at_utc}`;
}
function nowIso() {
  return new Date().toISOString();
}
function nextRetryAtISO(attemptCount) {
  const backoffMinutes = [1, 5, 15, 60, 360];
  const idx = Math.min(Math.max(attemptCount - 1, 0), backoffMinutes.length - 1);
  return new Date(Date.now() + backoffMinutes[idx] * 60 * 1000).toISOString();
}
async function addEvent(reminderId, eventType, details = {}, provider = null, attemptNo = null) {
  await supabase.from("reminder_events").insert({
    reminder_id: reminderId,
    event_type: eventType,
    provider,
    attempt_no: attemptNo,
    details
  });
}

// ===== Auth FS snapshot helpers =====
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function removeDirIfExists(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function walkFiles(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkFiles(full));
    else out.push(full);
  }
  return out;
}

function snapshotFolderToJson(dir) {
  const files = walkFiles(dir);
  const json = {};
  for (const f of files) {
    const rel = path.relative(dir, f).replace(/\\/g, "/");
    const buf = fs.readFileSync(f);
    json[rel] = buf.toString("base64");
  }
  return json;
}

function restoreFolderFromJson(dir, stateJson) {
  ensureDir(dir);
  for (const rel of Object.keys(stateJson || {})) {
    const full = path.join(dir, rel);
    ensureDir(path.dirname(full));
    fs.writeFileSync(full, Buffer.from(stateJson[rel], "base64"));
  }
}

// ===== Auth DB sync =====
async function loadAuthStateFromDb() {
  const { data, error } = await supabase
    .from("wa_auth_state")
    .select("state_json")
    .eq("id", WA_AUTH_ROW_ID)
    .maybeSingle();

  if (error) {
    console.error("[WA-AUTH] load error:", error.message);
    return null;
  }
  return data?.state_json || null;
}

async function saveAuthStateToDb() {
  try {
    const stateJson = snapshotFolderToJson(WA_AUTH_PATH);

    const { error } = await supabase
      .from("wa_auth_state")
      .upsert({
        id: WA_AUTH_ROW_ID,
        state_json: stateJson,
        updated_at: nowIso()
      });

    if (error) {
      console.error("[WA-AUTH] save error:", error.message);
    } else {
      console.log("[WA-AUTH] state synced to Supabase");
    }
  } catch (err) {
    console.error("[WA-AUTH] snapshot failure:", err.message);
  }
}

async function restoreAuthStateFromDb() {
  try {
    const stateJson = await loadAuthStateFromDb();
    removeDirIfExists(WA_AUTH_PATH);
    ensureDir(WA_AUTH_PATH);

    if (stateJson && Object.keys(stateJson).length > 0) {
      restoreFolderFromJson(WA_AUTH_PATH, stateJson);
      console.log("[WA-AUTH] restored from Supabase");
    } else {
      console.log("[WA-AUTH] no prior state in Supabase (fresh link needed)");
    }
  } catch (err) {
    console.error("[WA-AUTH] restore failure:", err.message);
  }
}

// ===== Baileys Init =====
async function initBaileys() {
  try {
    await restoreAuthStateFromDb();

    const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_PATH);
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" })
    });

    waSock.ev.on("creds.update", async () => {
      await saveCreds();
      await saveAuthStateToDb();
    });

    waSock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQrText = qr;
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr, { margin: 1, width: 360 });
        } catch {
          latestQrDataUrl = null;
        }
        console.log("[WA] Scan this QR in WhatsApp (Linked Devices):");
        qrcodeTerminal.generate(qr, { small: true });
      }

      if (connection === "open") {
        waReady = true;
        waConnectedAt = nowIso();
        latestQrText = null;
        latestQrDataUrl = null;
        lastWaError = null;
        console.log("[WA] Connected successfully");

        // Save one more snapshot after open
        await saveAuthStateToDb();
      }

      if (connection === "close") {
        waReady = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        lastWaError = `closed statusCode=${statusCode ?? "unknown"}`;
        console.log(`[WA] Connection closed. Reconnect=${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => initBaileys(), 4000);
        } else {
          console.log("[WA] Logged out. Re-link required.");
        }
      }
    });
    waSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        await handleInboundMessage(msg);
      }
    });

  } catch (err) {
    waReady = false;
    lastWaError = err.message;
    console.error("[WA] Init error:", err.message);
    setTimeout(() => initBaileys(), 5000);
  }
}

// ===== Provider Senders =====
async function sendViaBaileys(reminder, message) {
  if (DRY_RUN) {
    console.log(`[DRY RUN][BAILEYS] to ${reminder.user_phone_e164}: ${message}`);
    return { ok: true, providerMessageId: `dry-baileys-${Date.now()}` };
  }

  if (!waSock || !waReady) {
    return { ok: false, error: "Baileys not connected/ready", transient: true };
  }

  try {
    const jid = normalizeToWaJid(reminder.user_phone_e164);
    const sent = await waSock.sendMessage(jid, { text: message });
    return { ok: true, providerMessageId: sent?.key?.id || null };
  } catch (err) {
    return { ok: false, error: err.message, transient: true };
  }
}

async function sendViaMeta(_reminder, _message) {
  if (DRY_RUN) {
    console.log(`[DRY RUN][META] fallback path used`);
    return { ok: true, providerMessageId: `dry-meta-${Date.now()}` };
  }
  return { ok: false, error: "Meta provider not configured yet", transient: true };
}

async function sendViaProvider(provider, reminder, message) {
  if (provider === "baileys") return sendViaBaileys(reminder, message);
  if (provider === "meta") return sendViaMeta(reminder, message);
  return { ok: false, error: `Unknown provider: ${provider}`, transient: false };
}

async function sendWithFailover(reminder, message) {
  const first = await sendViaProvider(PRIMARY_PROVIDER, reminder, message);
  if (first.ok) return { ok: true, provider: PRIMARY_PROVIDER, providerMessageId: first.providerMessageId };

  const second = await sendViaProvider(SECONDARY_PROVIDER, reminder, message);
  if (second.ok) return { ok: true, provider: SECONDARY_PROVIDER, providerMessageId: second.providerMessageId };

  return {
    ok: false,
    transient: Boolean(first.transient || second.transient),
    error: `Both providers failed. primary=${first.error || "unknown"} | secondary=${second.error || "unknown"}`
  };
}

// ===== Inbound: Command Parser =====
function parseCommand(text) {
  if (!text) return { command: 'UNKNOWN', args: {} };
  const upper = text.trim().toUpperCase();
  if (upper === 'DONE')   return { command: 'DONE',   args: {} };
  if (upper === 'STOP')   return { command: 'STOP',   args: {} };
  if (upper === 'NEXT')   return { command: 'NEXT',   args: {} };
  if (upper === 'STATUS') return { command: 'STATUS', args: {} };
  const snoozeMatch = upper.match(/^SNOOZE(?:\s+(\d+))?$/);
  if (snoozeMatch) return { command: 'SNOOZE', args: { minutes: parseInt(snoozeMatch[1] || '60', 10) } };
  return { command: 'UNKNOWN', args: { original_text: text.slice(0, 200) } };
}

// ===== Inbound: Command Executor =====
async function executeCommand(command, args, contactId, cmdId, phoneE164, replyJid) {
  const jid = replyJid || normalizeToWaJid(phoneE164);
  let replyText = null;
  let executionNote = null;

  try {
    if (command === 'STOP') {
      await supabase.from('wa_contact_prefs').upsert(
        { client_contact_id: contactId, opt_status: 'opted_out', whatsapp_enabled: false, last_opt_change_at: nowIso(), updated_at: nowIso() },
        { onConflict: 'client_contact_id' }
      );
      replyText = 'You have been unsubscribed from AFS Legal reminders. Reply START to re-subscribe.';
      executionNote = 'opted_out';

    } else if (command === 'DONE') {
      const { data: rows } = await supabase
        .from('reminders').select('id, title')
        .eq('user_phone_e164', phoneE164).eq('status', 'notified')
        .order('notified_at', { ascending: false }).limit(1);
      if (rows?.length) {
        await addEvent(rows[0].id, 'acknowledged', { via: 'whatsapp_reply' });
        replyText = `Got it. "${rows[0].title}" marked as acknowledged.`;
        executionNote = `ack reminder ${rows[0].id}`;
      } else {
        replyText = 'No recent reminders to acknowledge.';
        executionNote = 'no_notified_reminder_found';
      }

    } else if (command === 'SNOOZE') {
      const minutes = args.minutes || 60;
      const { data: rows } = await supabase
        .from('reminders').select('id, title')
        .eq('user_phone_e164', phoneE164).in('status', ['pending', 'retrying'])
        .order('scheduled_at_utc', { ascending: true }).limit(1);
      if (rows?.length) {
        const newTime = new Date(Date.now() + minutes * 60 * 1000).toISOString();
        await supabase.from('reminders').update({ status: 'pending', scheduled_at_utc: newTime, next_retry_at: null }).eq('id', rows[0].id);
        await addEvent(rows[0].id, 'snoozed', { minutes, new_time: newTime, via: 'whatsapp_reply' });
        replyText = `"${rows[0].title}" snoozed for ${minutes} minute${minutes !== 1 ? 's' : ''}.`;
        executionNote = `snoozed ${rows[0].id} by ${minutes}m`;
      } else {
        replyText = 'No upcoming reminders to snooze.';
        executionNote = 'no_reminder_found';
      }

    } else if (command === 'NEXT') {
      const { data: rows } = await supabase
        .from('reminders').select('title, scheduled_at_utc')
        .eq('user_phone_e164', phoneE164).in('status', ['pending', 'retrying'])
        .order('scheduled_at_utc', { ascending: true }).limit(1);
      if (rows?.length) {
        replyText = `⚖️ Next reminder:\n"${rows[0].title}"\nScheduled: ${rows[0].scheduled_at_utc}`;
        executionNote = 'replied with next reminder';
      } else {
        replyText = 'You have no upcoming reminders.';
        executionNote = 'no_pending_reminders';
      }

    } else if (command === 'STATUS') {
      const { data: rows } = await supabase
        .from('reminders').select('title, scheduled_at_utc')
        .eq('user_phone_e164', phoneE164).in('status', ['pending', 'retrying'])
        .order('scheduled_at_utc', { ascending: true }).limit(5);
      if (rows?.length) {
        const lines = rows.map((r, i) => `${i + 1}. ${r.title} — ${r.scheduled_at_utc}`);
        replyText = `⚖️ Your upcoming reminders:\n${lines.join('\n')}`;
        executionNote = `replied with ${rows.length} reminders`;
      } else {
        replyText = 'You have no upcoming reminders.';
        executionNote = 'no_pending_reminders';
      }
    }

    if (replyText) {
      if (DRY_RUN) {
        console.log(`[DRY RUN][REPLY] to ${phoneE164}: ${replyText}`);
      } else if (waSock && waReady) {
        await waSock.sendMessage(jid, { text: replyText });
      }
    }

    await supabase.from('wa_commands').update({ execution_status: 'executed', execution_note: executionNote, executed_at: nowIso() }).eq('id', cmdId);
    console.log(`[CMD] ${command} executed for ${phoneE164}: ${executionNote}`);

  } catch (err) {
    console.error(`[CMD ERROR] ${command}:`, err.message);
    await supabase.from('wa_commands').update({ execution_status: 'failed', execution_note: err.message }).eq('id', cmdId);
  }
}

// ===== Inbound: Message Handler =====
async function handleInboundMessage(msg) {
  try {
    if (msg.key.fromMe) return;
    const jid = msg.key.remoteJid;
    if (!jid || jid === 'status@broadcast' || jid.endsWith('@g.us')) return;

    const phoneE164 = `+${jid.split('@')[0]}`;
    const msgContent = msg.message || {};

    // Detect type and text
    let messageType = 'unknown';
    let messageText = null;
    if (msgContent.conversation) {
      messageType = 'text'; messageText = msgContent.conversation;
    } else if (msgContent.extendedTextMessage?.text) {
      messageType = 'text'; messageText = msgContent.extendedTextMessage.text;
    } else if (msgContent.buttonsResponseMessage) {
      messageType = 'button'; messageText = msgContent.buttonsResponseMessage.selectedDisplayText;
    } else if (msgContent.listResponseMessage) {
      messageType = 'list'; messageText = msgContent.listResponseMessage.title;
    } else if (msgContent.imageMessage || msgContent.videoMessage || msgContent.audioMessage || msgContent.documentMessage) {
      messageType = 'media';
    }

    // 1. Upsert client_contact
    const { data: contact, error: contactErr } = await supabase
      .from('client_contacts')
      .upsert({ phone_e164: phoneE164 }, { onConflict: 'phone_e164' })
      .select('id').single();
    if (contactErr) throw contactErr;

    // 2. Upsert wa_conversation
    const { data: conv, error: convErr } = await supabase
      .from('wa_conversations')
      .upsert(
        { client_contact_id: contact.id, provider: 'baileys', last_inbound_at: nowIso(), updated_at: nowIso() },
        { onConflict: 'client_contact_id,provider' }
      )
      .select('id').single();
    if (convErr) throw convErr;

    // 3. Persist inbound message (skip if already recorded)
    if (msg.key.id) {
      const { data: existing } = await supabase
        .from('wa_messages_inbound')
        .select('id')
        .eq('provider_message_id', msg.key.id)
        .eq('provider', 'baileys')
        .maybeSingle();
      if (existing) return;
    }

    const { data: inbound, error: inboundErr } = await supabase
      .from('wa_messages_inbound')
      .insert({
        conversation_id: conv.id,
        provider: 'baileys',
        provider_message_id: msg.key.id || null,
        from_phone_e164: phoneE164,
        message_type: messageType,
        message_text: messageText,
        payload: msgContent
      })
      .select('id').single();
    if (inboundErr) throw inboundErr;

    console.log(`[INBOUND] ${phoneE164} type=${messageType} text="${(messageText || '').slice(0, 60)}"`);

    // 4. Skip command processing if opted out
    const { data: prefs } = await supabase
      .from('wa_contact_prefs').select('opt_status')
      .eq('client_contact_id', contact.id).maybeSingle();
    if (prefs?.opt_status === 'opted_out' || prefs?.opt_status === 'blocked') return;

    // 5. Parse + persist command
    const { command, args } = parseCommand(messageText);
    const { data: cmd, error: cmdErr } = await supabase
      .from('wa_commands')
      .insert({ inbound_id: inbound.id, command, command_args: args })
      .select('id').single();
    if (cmdErr) throw cmdErr;

    // 6. Execute (skip UNKNOWN)
    if (command !== 'UNKNOWN') {
      await executeCommand(command, args, contact.id, cmd.id, phoneE164, jid);
    }

  } catch (err) {
    console.error('[INBOUND ERROR]', err.message);
  }
}

// ===== API =====
app.get("/", (_req, res) => {
  res.send("AFS Reminder System Running (DB-persisted WA auth)");
});

app.get("/wa/status", (_req, res) => {
  res.json({
    connected: waReady,
    hasQr: Boolean(latestQrText),
    dryRun: DRY_RUN,
    primary: PRIMARY_PROVIDER,
    secondary: SECONDARY_PROVIDER,
    connectedAt: waConnectedAt,
    lastError: lastWaError,
    authPath: WA_AUTH_PATH,
    authPersistence: "supabase:wa_auth_state"
  });
});

app.get("/wa/qr", (_req, res) => {
  if (waReady) {
    return res.send(`<html><body style="font-family:Arial;padding:20px"><h2>WhatsApp connected ✅</h2></body></html>`);
  }
  if (!latestQrDataUrl) {
    return res.send(`<html><body style="font-family:Arial;padding:20px"><h2>QR not ready ⏳</h2><p>Refresh in a few seconds.</p></body></html>`);
  }
  return res.send(`
    <html><body style="font-family:Arial;padding:20px">
      <h2>Scan in WhatsApp → Linked Devices</h2>
      <img src="${latestQrDataUrl}" alt="WA QR" />
    </body></html>
  `);
});

app.post("/reminders/add", async (req, res) => {
  try {
    const { title, date, user } = req.body;
    if (!title || !date || !user || !user.phone) {
      return res.status(400).json({ error: "title, date, user.phone are required" });
    }
    if (!isValidE164(user.phone)) {
      return res.status(400).json({ error: "user.phone must be E.164 format (+countrycode...)" });
    }

    const scheduled = new Date(date);
    if (isNaN(scheduled.getTime())) {
      return res.status(400).json({ error: "Invalid date. Use ISO format." });
    }

    const payload = {
      title,
      message: null,
      user_name: user.name || null,
      user_phone_e164: user.phone,
      user_timezone: "UTC",
      scheduled_at_utc: scheduled.toISOString(),
      standard_dispatch_hour: 7,
      status: "pending",
      attempt_count: 0,
      max_attempts: 5,
      provider: PRIMARY_PROVIDER
    };

    const { data, error } = await supabase.from("reminders").insert(payload).select().single();
    if (error) throw error;

    await addEvent(data.id, "created", { source: "api" });
    console.log(`[ADD] Reminder ${data.id} created for ${data.user_phone_e164}`);
    return res.json({ message: "Reminder added", reminder: data });
  } catch (err) {
    console.error("ADD ERROR:", err.message);
    return res.status(500).json({ error: "Failed to add reminder", detail: err.message });
  }
});

// ===== Worker =====
async function processOneReminder(reminder) {
  console.log(`[TRIGGER] Reminder ${reminder.id} is due`);

  const message = reminder.message || formatMessage(reminder);
  const result = await sendWithFailover(reminder, message);

  if (result.ok) {
    const { error } = await supabase
      .from("reminders")
      .update({
        status: "notified",
        notified_at: nowIso(),
        provider: result.provider
      })
      .eq("id", reminder.id)
      .eq("status", "processing");
    if (error) throw error;

    await addEvent(reminder.id, "sent", { providerMessageId: result.providerMessageId }, result.provider, reminder.attempt_count + 1);
    console.log(`[SUCCESS] Reminder ${reminder.id} marked as notified via ${result.provider}`);
    return;
  }

  const nextAttempt = (reminder.attempt_count || 0) + 1;
  const maxAttempts = reminder.max_attempts || 5;

  if (nextAttempt >= maxAttempts) {
    const { error } = await supabase
      .from("reminders")
      .update({
        status: "failed",
        attempt_count: nextAttempt,
        last_error_code: "SEND_FAILED",
        last_error_message: result.error
      })
      .eq("id", reminder.id)
      .eq("status", "processing");
    if (error) throw error;

    await addEvent(reminder.id, "failed", { error: result.error }, null, nextAttempt);
    console.log(`[FAILED] Reminder ${reminder.id} permanently failed: ${result.error}`);
    return;
  }

  const retryAt = nextRetryAtISO(nextAttempt);
  const { error } = await supabase
    .from("reminders")
    .update({
      status: "retrying",
      attempt_count: nextAttempt,
      next_retry_at: retryAt,
      last_error_code: "SEND_RETRY",
      last_error_message: result.error
    })
    .eq("id", reminder.id)
    .eq("status", "processing");
  if (error) throw error;

  await addEvent(reminder.id, "retried", { error: result.error, next_retry_at: retryAt }, null, nextAttempt);
  console.log(`[RETRY] Reminder ${reminder.id} attempt=${nextAttempt} reason="${result.error}" next=${retryAt}`);
}

async function claimAndProcessDue() {
  const now = nowIso();
  console.log(`[CHECK] Running reminder scan at ${now}`);

  const { data: pendingDue, error: pendingErr } = await supabase
    .from("reminders")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_at_utc", now)
    .order("scheduled_at_utc", { ascending: true })
    .limit(MAX_BATCH);
  if (pendingErr) throw pendingErr;

  const { data: retryDue, error: retryErr } = await supabase
    .from("reminders")
    .select("*")
    .eq("status", "retrying")
    .lte("next_retry_at", now)
    .order("next_retry_at", { ascending: true })
    .limit(MAX_BATCH);
  if (retryErr) throw retryErr;

  const due = [...(pendingDue || []), ...(retryDue || [])];

  for (const row of due) {
    const expectedStatus = row.status;
    const { data: claimed, error: claimErr } = await supabase
      .from("reminders")
      .update({ status: "processing" })
      .eq("id", row.id)
      .eq("status", expectedStatus)
      .select()
      .single();
    if (claimErr || !claimed) continue;

    await addEvent(claimed.id, "claimed", { from_status: expectedStatus });

    try {
      await processOneReminder(claimed);
    } catch (err) {
      console.error("PROCESS ERROR:", err.message);
      await addEvent(claimed.id, "process_error", { error: err.message });
    }
  }
}

setInterval(() => {
  claimAndProcessDue().catch((e) => console.error("SCHEDULER ERROR:", e.message));
}, SCAN_INTERVAL_MS);

// ===== Start =====
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DRY_RUN=${DRY_RUN}, PRIMARY_PROVIDER=${PRIMARY_PROVIDER}, SECONDARY_PROVIDER=${SECONDARY_PROVIDER}`);
  console.log(`SCAN_INTERVAL_MS=${SCAN_INTERVAL_MS}, MAX_BATCH=${MAX_BATCH}`);
  console.log(`WA_AUTH_PATH=${WA_AUTH_PATH}`);
  await initBaileys();
});
