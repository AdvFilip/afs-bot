const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// ===== ENV =====
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Failover order (as requested: Baileys primary, Meta fallback)
const PRIMARY_PROVIDER = (process.env.PRIMARY_PROVIDER || "baileys").toLowerCase();
const SECONDARY_PROVIDER = (process.env.SECONDARY_PROVIDER || "meta").toLowerCase();

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ===== Helpers =====
function isValidE164(phone) {
  return /^\+[1-9]\d{7,14}$/.test(phone);
}

function formatMessage(reminder) {
  return `⚖️ AFS Legal Reminder\n\nReminder: ${reminder.title}\nTime: ${reminder.scheduled_at_utc}`;
}

function nextRetryAtISO(attemptCount) {
  // attempt 1->1m, 2->5m, 3->15m, 4->1h, 5->6h
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
    details,
  });
}

// ===== Provider stubs =====
// Keep DRY_RUN=true until real Baileys/Meta sending is connected.
async function sendViaProvider(provider, reminder, message) {
  if (DRY_RUN) {
    console.log(`[DRY RUN][${provider.toUpperCase()}] to ${reminder.user_phone_e164}: ${message}`);
    return { ok: true, providerMessageId: `dry-${provider}-${Date.now()}` };
  }

  // TODO: plug real provider calls here
  // if (provider === "baileys") { ... }
  // if (provider === "meta") { ... }

  return { ok: false, error: `${provider} provider not configured` };
}

async function sendWithFailover(reminder, message) {
  const first = await sendViaProvider(PRIMARY_PROVIDER, reminder, message);
  if (first.ok) return { ok: true, provider: PRIMARY_PROVIDER, providerMessageId: first.providerMessageId };

  const second = await sendViaProvider(SECONDARY_PROVIDER, reminder, message);
  if (second.ok) return { ok: true, provider: SECONDARY_PROVIDER, providerMessageId: second.providerMessageId };

  return {
    ok: false,
    error: `Both providers failed. primary=${first.error || "unknown"}, secondary=${second.error || "unknown"}`
  };
}

// ===== Health =====
app.get("/", (_req, res) => {
  res.send("AFS Reminder System Running (Supabase)");
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

    const { data, error } = await supabase
      .from("reminders")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    await addEvent(data.id, "created", { source: "api" });

    console.log(`[ADD] Reminder ${data.id} created for ${data.user_phone_e164}`);
    return res.json({ message: "Reminder added", reminder: data });
  } catch (err) {
    console.error("ADD ERROR:", err.message);
    return res.status(500).json({ error: "Failed to add reminder", detail: err.message });
  }
});

// ===== List reminders =====
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

  const message = formatMessage(reminder);
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

  // pending due
  const { data: pendingDue, error: pendingErr } = await supabase
    .from("reminders")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_at_utc", now)
    .order("scheduled_at_utc", { ascending: true })
    .limit(20);

  if (pendingErr) throw pendingErr;

  // retrying due
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
    // claim lock: only process if still pending/retrying
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
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Supabase mode active");
  console.log(`DRY_RUN=${DRY_RUN}, PRIMARY_PROVIDER=${PRIMARY_PROVIDER}, SECONDARY_PROVIDER=${SECONDARY_PROVIDER}`);
});
