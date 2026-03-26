const express = require("express");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

/* =========================
   CONFIG
========================= */
const DRY_RUN = true;

/* =========================
   IN-MEMORY DATABASE
========================= */
let reminders = [];

/* =========================
   MESSAGE SERVICE (ABSTRACTION)
========================= */
async function sendMessage(user, message) {
    if (DRY_RUN) {
        console.log(`[DRY RUN] Message to ${user.phone}: ${message}`);
        return;
    }

    // Future: Meta API integration goes here
    console.log(`[LIVE] Sending message to ${user.phone}: ${message}`);
}

/* =========================
   HELPER: FORMAT MESSAGE
========================= */
function formatMessage(reminder) {
    return `⚖️ AFS Legal Reminder\n\nReminder: ${reminder.title}\nTime: ${reminder.date}`;
}

/* =========================
   ADD REMINDER
========================= */
app.post("/reminders/add", (req, res) => {
    const { title, date, user } = req.body;

    if (!title || !date || !user || !user.phone) {
        return res.status(400).json({
            error: "title, date, and user.phone are required"
        });
    }

    const reminder = {
        id: Date.now(),
        title,
        date,
        status: "pending",
        user
    };

    reminders.push(reminder);

    console.log(`[ADD] Reminder ${reminder.id} created for ${user.phone}`);

    res.json({
        message: "Reminder added",
        reminder
    });
});

/* =========================
   GET ALL REMINDERS
========================= */
app.get("/reminders", (req, res) => {
    res.json(reminders);
});

/* =========================
   GET PENDING
========================= */
app.get("/reminders/pending", (req, res) => {
    const data = reminders.filter(r => r.status === "pending");
    res.json(data);
});

/* =========================
   GET NOTIFIED
========================= */
app.get("/reminders/notified", (req, res) => {
    const data = reminders.filter(r => r.status === "notified");
    res.json(data);
});

/* =========================
   TRIGGER ENGINE
========================= */
async function checkDueReminders() {
    const now = new Date();

    console.log(`[CHECK] Running reminder scan at ${now.toISOString()}`);

    for (let reminder of reminders) {
        if (reminder.status !== "pending") continue;

        const reminderTime = new Date(reminder.date);

        if (reminderTime <= now) {
            console.log(`[TRIGGER] Reminder ${reminder.id} is due`);

            const message = formatMessage(reminder);

            await sendMessage(reminder.user, message);

            reminder.status = "notified";

            console.log(`[SUCCESS] Reminder ${reminder.id} marked as notified`);
        }
    }
}

/* =========================
   SCHEDULER (EVERY 10 SEC)
========================= */
setInterval(checkDueReminders, 10000);

/* =========================
   HEALTH CHECK
========================= */
app.get("/", (req, res) => {
    res.send("AFS Reminder System Running");
});

/* =========================
   START SERVER
========================= */
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
