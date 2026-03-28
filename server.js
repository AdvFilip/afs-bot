const express = require("express");
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

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ===== WA Globals =====
let waSock = null;
let waReady = false;
let latestQrText = null;      // raw QR text from Baileys
let latestQrDataUrl = null;   // PNG data URL for browser display

// ===== Helpers =====
function isValidE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function normalizeToWaJid(phone) {
  const clean = phone.replace(/[^\d]/g, "");
  return `${clean}@s.whatsapp.net`;
}

function formatMessage(reminder) {
  return `⚖️ AFS Legal Reminder\n\nReminder: ${reminder.title}\nTime: ${reminder.scheduled_at_utc}`;
}

function nextRetryAtISO(attemptCount) {
  const backoffMinutes = [1, 5, 15, 60, 360];
  const idx = Math.min(Math.max(attemptCount - 1, 0), backoffMinutes.length - 1);
  const minutes = backoffMinutes[idx];
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

async function addEvent(reminderId, eventType, details = {}, provider = null) {
  await supabase.from("reminder_events").insert({
    reminder_id: reminderId,
    event_type: eventType,
    provider,
    details
  });
}

// ===== Baileys Init =====
async function initBaileys() {
  try {
    const { state, saveCreds } = await useMultiFileAuthState("./wa_auth");
    const { version } = await fetchLatestBaileysVersion();

    waSock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      logger: pino({ level: "silent" })
    });

    waSock.ev.on("creds.update", saveCreds);

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
        latestQrText = null;
        latestQrDataUrl = null;
        console.log("[WA] Connected successfully");
      }

      if (connection === "close") {
        waReady = false;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
        console.log(`[WA] Connection closed. Reconnect=${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => initBaileys(), 4000);
        } else {
          console.log("[WA] Logged out. Delete wa_auth and re-link.");
        }
      }
    });
  } catch (err) {
    waReady = false;
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
    return { ok: false, error: "Baileys not connected/ready" };
  }

  try {
    const jid = normalizeToWaJid(reminder.user_phone_e164);
    const sent = await waSock.sendMessage(jid, { text: message });
    return { ok: true, providerMessageId: sent?.key?.id || null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

async function sendViaMeta(_reminder, _message) {
  if (DRY_RUN) {
    console.log(`[DRY RUN][META] fallback path used`);
    return { ok: true, providerMessageId: `dry-meta-${Date.now()}` };
  }
  return { ok: false, error: "Meta provider not configured yet" };
}

async function sendViaProvider(provider, reminder, message) {
  if (provider === "baileys") return sendViaBaileys(reminder, message);
  if (provider === "meta") return sendViaMeta(reminder, message);
  return { ok: false, error: `Unknown provider: ${provider}` };
}

async function sendWithFailover(reminder, message) {
  const first = await sendViaProvider(PRIMARY_PROVIDER, reminder, message);
  if (first.ok) return { ok: true, provider: PRIMARY_PROVIDER, providerMessageId: first.providerMessageId };

  console.log(`[FAILOVER] Primary failed (${PRIMARY_PROVIDER}): ${first.error}`);

  const second = await sendViaProvider(SECONDARY_PROVIDER, reminder, message);
  if (second.ok) return { ok: true, provider: SECONDARY_PROVIDER, providerMessageId: second.providerMessageId };

  return {
    ok: false,
    error: `Both providers failed. primary=${first.error || "unknown"}, secondary=${second.error || "unknown"}`
  };
}

// ===== Health =====
app.get("/", (_req, res) => {
  res.send("AFS Reminder System Running (Supabase + Baileys)");
});

// ===== NEW: WA status endpoint =====
app.get("/wa/status", (_req, res) => {
  res.json({
    connected: waReady,
    hasQr: Boolean(latestQrText),
    dryRun: DRY_RUN,
    primary: PRIMARY_PROVIDER,
    secondary: SECONDARY_PROVIDER
  });
});

// ===== NEW: WA QR endpoint (scannable image) =====
app.get("/wa/qr", (_req, res) => {
  if (waReady) {
    return res.send(`
      <html><body style="font-family:Arial;padding:20px">
      <h2>WhatsApp is already connected ✅</h2>
      </body></html>
    `);
  }

  if (!latestQrDataUrl) {
    return res.send(`
      <html><body style="font-family:Arial;padding:20px">
      <h2>QR not ready yet ⏳</h2>
      <p>Refresh in a few seconds.</p>
      </body></html>
    `);
  }

  return res.send(`
    <html>
      <body style="font-family:Arial;padding:20px">
        <h2>Scan in WhatsApp → Linked Devices</h2>
        <img src="${latestQrDataUrl}" alt="WA QR" />
      </body>
    </html>
  `);
});

// ===== Add Reminder =====
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

// ===== List Reminders =====
app.get("/reminders", async (_req, res) => {
  try {
    const { data, error } = await supabase
      .from("reminders")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100);
    if (error) throw error;
    return res.json(data);
  } catch (err) {
    console.error("LIST ERROR:", err.message);
    return res.status(500).json({ error: "Failed to list reminders", detail: err.message });
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
        notified_at: new Date().toISOString(),
        provider: result.provider
      })
      .eq("id", reminder.id)
      .eq("status", "processing");
    if (error) throw error;

    await addEvent(reminder.id, "sent", { providerMessageId: result.providerMessageId }, result.provider);
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

    await addEvent(reminder.id, "failed", { error: result.error });
    console.log(`[FAILED] Reminder ${reminder.id} permanently failed`);
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

  await addEvent(reminder.id, "retried", { next_retry_at: retryAt, error: result.error });
  console.log(`[RETRY] Reminder ${reminder.id} scheduled at ${retryAt}`);
}

async function claimAndProcessDue() {
  const now = new Date().toISOString();
  console.log(`[CHECK] Running reminder scan at ${now}`);

  const { data: pendingDue, error: pendingErr } = await supabase
    .from("reminders")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_at_utc", now)
    .order("scheduled_at_utc", { ascending: true })
    .limit(20);
  if (pendingErr) throw pendingErr;

  const { data: retryDue, error: retryErr } = await supabase
    .from("reminders")
    .select("*")
    .eq("status", "retrying")
    .lte("next_retry_at", now)
    .order("next_retry_at", { ascending: true })
    .limit(20);
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
    }
  }
}

setInterval(() => {
  claimAndProcessDue().catch((e) => console.error("SCHEDULER ERROR:", e.message));
}, 10000);

// ===== Start =====
app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`DRY_RUN=${DRY_RUN}, PRIMARY_PROVIDER=${PRIMARY_PROVIDER}, SECONDARY_PROVIDER=${SECONDARY_PROVIDER}`);
  console.log("Supabase mode active");
  await initBaileys();
});
