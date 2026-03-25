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

// Mark reminder as completed
router.put('/complete/:id', (req, res) => {
  const { id } = req.params;

  const reminder = reminders.find(r => r.id == id);

  if (!reminder) {
    return res.status(404).json({ message: 'Reminder not found' });
  }

  reminder.status = 'completed';

  res.json({ message: 'Reminder marked as completed', reminder });
});

module.exports = router;
