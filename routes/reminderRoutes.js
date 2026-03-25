const express = require('express');
const router = express.Router();

let reminders = [];

// Add reminder
router.post('/add', (req, res) => {
  const { title, date } = req.body;

  const reminder = {
    id: Date.now(),
    title,
    date,
    status: 'pending'
  };

  reminders.push(reminder);

  res.json({ message: 'Reminder added', reminder });
});

// Get all reminders
router.get('/', (req, res) => {
  res.json(reminders);
});

module.exports = router;
