const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());

// ===== ENV =====
const DRY_RUN = String(process.env.DRY_RUN || "true").toLowerCase() === "true";
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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

async function sendMessage(reminder, message) {
  if (DRY_RUN) {
    console.log(`[DRY RUN] Message to ${reminder.user_phone_e164}: ${message}`);
    return { ok: true };
  }
  // Real provider integration later
  return { ok: false, error: "Provider not configured" };
}

// ===== Health =====
app.get("/", (_req, res) => {
  res.send("AFS Reminder System Running (Supabase)");
});

// ===== Add Reminder (writes to Supabase) =====
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
      provider: "baileys",
    };

    const { data, error } = await supabase
      .from("reminders")
      .insert(payload)
      .select()
      .single();

    if (error) throw error;

    await supabase.from("reminder_events").insert({
      reminder_id: data.id,
      event_type: "created",
      details: { source: "api" },
    });

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

// ===== Scheduler =====
async function checkDueReminders() {
  const now = new Date().toISOString();
  console.log(`[CHECK] Running reminder scan at ${now}`);

  const { data: due, error } = await supabase
    .from("reminders")
    .select("*")
    .eq("status", "pending")
    .lte("scheduled_at_utc", now)
    .order("scheduled_at_utc", { ascending: true })
    .limit(20);

  if (error) {
    console.error("SCAN ERROR:", error.message);
    return;
  }

  for (const reminder of due || []) {
    const { data: claimed, error: claimErr } = await supabase
      .from("reminders")
      .update({ status: "processing" })
      .eq("id", reminder.id)
      .eq("status", "pending")
      .select()
      .single();

    if (claimErr || !claimed) continue;

    console.log(`[TRIGGER] Reminder ${claimed.id} is due`);

    const message = formatMessage(claimed);
    const sendResult = await sendMessage(claimed, message);

    if (sendResult.ok) {
      await supabase
        .from("reminders")
        .update({ status: "notified", notified_at: new Date().toISOString() })
        .eq("id", claimed.id)
        .eq("status", "processing");

      await supabase.from("reminder_events").insert({
        reminder_id: claimed.id,
        event_type: "sent",
        details: { mode: DRY_RUN ? "dry_run" : "live" },
      });

      console.log(`[SUCCESS] Reminder ${claimed.id} marked as notified`);
    } else {
      await supabase
        .from("reminders")
        .update({
          status: "failed",
          last_error_code: "SEND_FAILED",
          last_error_message: sendResult.error || "unknown",
        })
        .eq("id", claimed.id)
        .eq("status", "processing");

      await supabase.from("reminder_events").insert({
        reminder_id: claimed.id,
        event_type: "failed",
        details: { error: sendResult.error || "unknown" },
      });

      console.log(`[FAILED] Reminder ${claimed.id} marked as failed`);
    }
  }
}

setInterval(() => {
  checkDueReminders().catch((e) => console.error("SCHEDULER ERROR:", e.message));
}, 10000);

// ===== Start =====
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Supabase mode active");
});
