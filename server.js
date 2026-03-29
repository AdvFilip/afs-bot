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
const ECOURTS_API_KEY  = process.env.ECOURTS_API_KEY  || '';
const ECOURTS_API_BASE = process.env.ECOURTS_API_BASE || 'https://webapi.ecourtsindia.com';
const CASE_SYNC_HOUR   = parseInt(process.env.CASE_SYNC_HOUR || '6', 10);
const ADMIN_TOKEN      = process.env.ADMIN_TOKEN || '';

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
async function executeCommand(command, args, contactId, cmdId, phoneE164) {
  const jid = normalizeToWaJid(phoneE164);
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

    const phoneE164 = `+${jid.replace('@s.whatsapp.net', '')}`;
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

    // 3. Persist inbound message
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
      await executeCommand(command, args, contact.id, cmd.id, phoneE164);
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

// ===== Case Sync =====

function requireAdminToken(req, res) {
  if (ADMIN_TOKEN && req.headers['x-admin-token'] !== ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized. Set x-admin-token header.' });
    return false;
  }
  return true;
}

async function fetchCaseFromApi(cnr) {
  if (!ECOURTS_API_KEY) throw new Error('ECOURTS_API_KEY not configured');
  const url = `${ECOURTS_API_BASE}/api/partner/case/${encodeURIComponent(cnr)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${ECOURTS_API_KEY}` } });
  if (!res.ok) throw new Error(`eCourts API ${res.status} for ${cnr}`);
  const json = await res.json();
  return json?.data?.courtCaseData ?? null;
}

function mapApiCaseToRow(d) {
  const petitioners = Array.isArray(d.petitioners) ? d.petitioners : [];
  const respondents  = Array.isArray(d.respondents)  ? d.respondents  : [];
  const title = [petitioners[0], respondents[0]].filter(Boolean).join(' vs ') || d.caseNumber || d.cnr;
  const acts  = Array.isArray(d.actsAndSections)
    ? d.actsAndSections.join('; ')
    : (typeof d.actsAndSections === 'string' ? d.actsAndSections : null);
  return {
    cino:                 d.cnr,
    reference:            d.caseNumber             ?? null,
    title,
    case_type:            d.caseType               ?? null,
    case_status:          d.caseStatus === 'DISPOSED' ? 'closed' : 'open',
    filing_date:          d.filingDate             ?? null,
    registration_date:    d.registrationDate       ?? null,
    first_hearing_date:   d.firstHearingDate       ?? null,
    next_hearing_date:    d.nextHearingDate         ?? null,
    decision_date:        d.decisionDate           ?? null,
    petitioners,
    respondents,
    petitioner_advocates: Array.isArray(d.petitionerAdvocates) ? d.petitionerAdvocates : [],
    respondent_advocates: Array.isArray(d.respondentAdvocates) ? d.respondentAdvocates : [],
    judges:               Array.isArray(d.judges)              ? d.judges              : [],
    acts_and_sections:    acts,
    court_name:           d.courtName              ?? null,
    state_name:           d.state                  ?? null,
    district_name:        d.district               ?? null,
    court_no:             d.courtNo                ?? null,
    bench_name:           d.benchName              ?? null,
    purpose_name:         d.purpose                ?? null,
    judicial_section:     d.judicialSection        ?? null,
    court_code:           d.cnrCourtCode           ?? null,
    filing_number:        d.filingNumber           ?? null,
    raw_api_payload:      d,
    last_synced_at:       nowIso(),
    updated_at:           nowIso(),
  };
}

// Compute reminder time: 9 AM IST (03:30 UTC) on the day before the hearing
function reminderTimeForHearing(hearingDateStr) {
  const hearingUtcMidnight = new Date(hearingDateStr + 'T00:00:00Z');
  // Subtract 20.5 hours: gets us to previous day 03:30 UTC = 09:00 IST
  return new Date(hearingUtcMidnight.getTime() - (20.5 * 60 * 60 * 1000));
}

async function scheduleReminderForContact(cino, caseRow, phone, name) {
  if (!caseRow.next_hearing_date) return;
  const reminderAt = reminderTimeForHearing(caseRow.next_hearing_date);
  if (reminderAt <= new Date()) return; // already past

  // Cancel any existing pending/retrying reminder for this case+contact
  await supabase.from('reminders')
    .update({ status: 'failed', last_error_message: 'Superseded by updated hearing date' })
    .eq('user_phone_e164', phone)
    .eq('case_cino', cino)
    .in('status', ['pending', 'retrying']);

  const caseRef  = caseRow.reference || cino;
  const caseTitle = caseRow.title || caseRef;
  const message = [
    '⚖️ AFS Legal – Hearing Reminder',
    '',
    `Your case is scheduled for hearing tomorrow.`,
    `Case: ${caseRef}`,
    caseTitle,
    caseRow.court_name ? `Court: ${caseRow.court_name}` : null,
    caseRow.purpose_name ? `Purpose: ${caseRow.purpose_name}` : null,
    '',
    'Reply DONE once the hearing is over, or SNOOZE to delay this reminder.',
  ].filter(l => l !== null).join('\n');

  const { error: rErr } = await supabase.from('reminders').insert({
    title:            `Hearing tomorrow: ${caseRef}`,
    message,
    user_phone_e164:  phone,
    user_name:        name ?? null,
    user_timezone:    'Asia/Kolkata',
    scheduled_at_utc: reminderAt.toISOString(),
    status:           'pending',
    attempt_count:    0,
    max_attempts:     5,
    provider:         PRIMARY_PROVIDER,
    case_cino:        cino,
  });
  if (rErr) console.error(`[SYNC] Reminder insert error for ${phone}:`, rErr.message);
  else console.log(`[SYNC] Reminder → ${phone} at ${reminderAt.toISOString()} (${caseRow.next_hearing_date})`);
}

async function upsertCaseAndScheduleReminders(row, previousNextHearing) {
  const { error: upsertErr } = await supabase.from('cases').upsert(row, { onConflict: 'cino' });
  if (upsertErr) throw upsertErr;

  // Only reschedule if next_hearing_date is set and has changed
  if (!row.next_hearing_date || row.next_hearing_date === previousNextHearing) return;

  const { data: contacts } = await supabase
    .from('case_contacts')
    .select('client_contact_id, client_contacts(phone_e164, name)')
    .eq('cino', row.cino);
  if (!contacts?.length) return;

  for (const cc of contacts) {
    const phone = cc.client_contacts?.phone_e164;
    if (!phone) continue;
    await scheduleReminderForContact(row.cino, row, phone, cc.client_contacts?.name);
  }
}

async function syncOneCnr(cnr) {
  const { data: existing } = await supabase
    .from('cases').select('next_hearing_date').eq('cino', cnr).maybeSingle();

  const apiData = await fetchCaseFromApi(cnr);
  if (!apiData) { console.warn(`[SYNC] No data returned for ${cnr}`); return null; }

  const row = mapApiCaseToRow(apiData);
  await upsertCaseAndScheduleReminders(row, existing?.next_hearing_date ?? null);
  console.log(`[SYNC] ${cnr} → next_hearing=${row.next_hearing_date}`);
  return row.next_hearing_date;
}

async function runDailyCaseSync() {
  console.log('[SYNC] Daily case sync starting...');

  const yesterday   = new Date(); yesterday.setDate(yesterday.getDate() - 1);
  const sevenDaysAgo = new Date(); sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  // Cases to refresh: heard yesterday or earlier, not synced in 7 days, or never synced
  const { data: staleCases, error } = await supabase
    .from('cases')
    .select('cino')
    .or(`next_hearing_date.lte.${yesterday.toISOString().split('T')[0]},last_synced_at.lte.${sevenDaysAgo.toISOString()},last_synced_at.is.null`);

  if (error) { console.error('[SYNC] Query error:', error.message); return; }
  if (!staleCases?.length) { console.log('[SYNC] No stale cases to refresh.'); return; }

  console.log(`[SYNC] Refreshing ${staleCases.length} case(s)...`);
  let ok = 0, failed = 0;
  for (const { cino } of staleCases) {
    try { await syncOneCnr(cino); ok++; }
    catch (e) { console.error(`[SYNC] Failed ${cino}:`, e.message); failed++; }
    await new Promise(r => setTimeout(r, 300)); // 300ms between calls — avoids rate-limit
  }
  console.log(`[SYNC] Daily sync complete. ok=${ok} failed=${failed}`);
}

// POST /sync/cases — manual sync: { cnrs: ["CINO1", ...] } or empty body to run full delta sync
app.post('/sync/cases', async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  try {
    const cnrs = Array.isArray(req.body?.cnrs) ? req.body.cnrs.map(s => s.trim()).filter(Boolean) : null;
    if (cnrs?.length) {
      const results = [];
      for (const cnr of cnrs) {
        try {
          const nextHearing = await syncOneCnr(cnr);
          results.push({ cnr, status: 'ok', next_hearing_date: nextHearing });
        } catch (e) {
          results.push({ cnr, status: 'error', error: e.message });
        }
        await new Promise(r => setTimeout(r, 300));
      }
      return res.json({ synced: results.length, results });
    }
    // No CNRs → trigger full daily sync in background
    runDailyCaseSync().catch(e => console.error('[SYNC] bg error:', e.message));
    return res.json({ message: 'Daily case sync triggered in background' });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /sync/cases/search — seed cases via eCourts Case Search API
// Body: { advocates, petitioners, respondents, courtCodes, query, page }
app.post('/sync/cases/search', async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  if (!ECOURTS_API_KEY) return res.status(503).json({ error: 'ECOURTS_API_KEY not configured' });
  try {
    const params = new URLSearchParams();
    if (req.body.advocates)   params.set('advocates',   req.body.advocates);
    if (req.body.petitioners) params.set('petitioners', req.body.petitioners);
    if (req.body.respondents) params.set('respondents', req.body.respondents);
    if (req.body.courtCodes)  params.set('courtCodes',  req.body.courtCodes);
    if (req.body.query)       params.set('query',       req.body.query);
    if (req.body.page)        params.set('page',        String(req.body.page));

    const url = `${ECOURTS_API_BASE}/api/partner/search?${params.toString()}`;
    const apiRes = await fetch(url, { headers: { Authorization: `Bearer ${ECOURTS_API_KEY}` } });
    if (!apiRes.ok) throw new Error(`Search API returned ${apiRes.status}`);
    const json = await apiRes.json();
    const results = json?.data?.results ?? [];

    let upserted = 0;
    for (const item of results) {
      if (!item.cnr) continue;
      const petitioners = Array.isArray(item.petitioners) ? item.petitioners : [];
      const respondents  = Array.isArray(item.respondents)  ? item.respondents  : [];
      const row = {
        cino:                 item.cnr,
        reference:            item.registrationNumber ?? null,
        title:                [petitioners[0], respondents[0]].filter(Boolean).join(' vs ') || item.cnr,
        case_type:            item.caseType          ?? null,
        case_status:          item.caseStatus === 'DISPOSED' ? 'closed' : 'open',
        filing_date:          item.filingDate        ?? null,
        next_hearing_date:    item.nextHearingDate   ?? null,
        petitioners,
        respondents,
        petitioner_advocates: Array.isArray(item.petitionerAdvocates) ? item.petitionerAdvocates : [],
        respondent_advocates: Array.isArray(item.respondentAdvocates) ? item.respondentAdvocates : [],
        judges:               Array.isArray(item.judges) ? item.judges : [],
        court_code:           item.courtCode         ?? null,
        judicial_section:     item.judicialSection   ?? null,
        raw_api_payload:      item,
        last_synced_at:       nowIso(),
        updated_at:           nowIso(),
      };
      const { error: uErr } = await supabase.from('cases').upsert(row, { onConflict: 'cino' });
      if (uErr) console.error(`[SEARCH] upsert error ${item.cnr}:`, uErr.message);
      else upserted++;
    }
    return res.json({ found: results.length, upserted });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// POST /cases/:cino/contact — link a phone number to a case
// Body: { phone_e164, role?: "petitioner"|"respondent"|"other", notes? }
app.post('/cases/:cino/contact', async (req, res) => {
  if (!requireAdminToken(req, res)) return;
  try {
    const { cino } = req.params;
    const { phone_e164, role = 'petitioner', notes } = req.body;

    if (!phone_e164 || !isValidE164(phone_e164)) {
      return res.status(400).json({ error: 'phone_e164 must be valid E.164 format (e.g. +919876543210)' });
    }
    if (!['petitioner', 'respondent', 'other'].includes(role)) {
      return res.status(400).json({ error: 'role must be petitioner, respondent, or other' });
    }

    const { data: caseRow } = await supabase.from('cases').select('*').eq('cino', cino).maybeSingle();
    if (!caseRow) return res.status(404).json({ error: `Case ${cino} not found. Import it first.` });

    const { data: contact, error: cErr } = await supabase
      .from('client_contacts')
      .upsert({ phone_e164 }, { onConflict: 'phone_e164' })
      .select('id, name').single();
    if (cErr) throw cErr;

    const { error: linkErr } = await supabase.from('case_contacts').upsert(
      { cino, client_contact_id: contact.id, role, notes: notes ?? null, updated_at: nowIso() },
      { onConflict: 'cino,client_contact_id' }
    );
    if (linkErr) throw linkErr;

    // Schedule reminder immediately if case has a future hearing
    await scheduleReminderForContact(cino, caseRow, phone_e164, contact.name);

    return res.json({ message: 'Contact linked to case', cino, phone_e164, contact_id: contact.id });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /cases — list cases ordered by next hearing date
app.get('/cases', async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from('cases')
      .select('cino, reference, title, case_status, case_type, next_hearing_date, court_name, purpose_name, last_synced_at')
      .order('next_hearing_date', { ascending: true, nullsFirst: false })
      .limit(200);
    if (error) throw error;
    return res.json({ cases: data || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// GET /cases/:cino — case detail with linked contacts
app.get('/cases/:cino', async (req, res) => {
  try {
    const { data: caseRow, error } = await supabase
      .from('cases').select('*').eq('cino', req.params.cino).maybeSingle();
    if (error) throw error;
    if (!caseRow) return res.status(404).json({ error: 'Case not found' });

    const { data: contacts } = await supabase
      .from('case_contacts')
      .select('role, notes, created_at, client_contacts(phone_e164, name)')
      .eq('cino', req.params.cino);

    return res.json({ case: caseRow, contacts: contacts || [] });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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

// Daily case sync — fires once per day at CASE_SYNC_HOUR (default 6 AM server time)
let lastCaseSyncDate = null;
setInterval(() => {
  const now = new Date();
  if (now.getHours() === CASE_SYNC_HOUR) {
    const dateKey = now.toISOString().split('T')[0];
    if (lastCaseSyncDate !== dateKey) {
      lastCaseSyncDate = dateKey;
      runDailyCaseSync().catch(e => console.error('[SYNC] Daily sync error:', e.message));
    }
  }
}, 60_000); // check every minute

// ===== Start =====
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DRY_RUN=${DRY_RUN}, PRIMARY_PROVIDER=${PRIMARY_PROVIDER}, SECONDARY_PROVIDER=${SECONDARY_PROVIDER}`);
  console.log(`SCAN_INTERVAL_MS=${SCAN_INTERVAL_MS}, MAX_BATCH=${MAX_BATCH}`);
  console.log(`WA_AUTH_PATH=${WA_AUTH_PATH}`);
  await initBaileys();
});
