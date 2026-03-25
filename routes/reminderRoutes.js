const express = require('express');
const router = express.Router();

let reminders = [];

// Add reminder
router.post('/add', (req, res) => {
  try {
    const { title, date } = req.body;

    if (!title || !date) {
      return res.status(400).json({ message: 'Title and date required' });
    }

    const reminder = {
      id: Date.now(),
      title,
      date,
      status: 'pending'
    };

    reminders.push(reminder);

    res.json({ message: 'Reminder added', reminder });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error adding reminder' });
  }
});

// Get all reminders
router.get('/', (req, res) => {
  try {
    res.json(reminders);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error fetching reminders' });
  }
});

// Mark reminder as completed
router.put('/complete/:id', (req, res) => {
  try {
    const { id } = req.params;

    const reminder = reminders.find(r => r.id == id);

    if (!reminder) {
      return res.status(404).json({ message: 'Reminder not found' });
    }

    reminder.status = 'completed';

    res.json({ message: 'Reminder marked as completed', reminder });

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error updating reminder' });
  }
});

// Get due reminders (robust)
router.get('/due', (req, res) => {
  try {
    const now = new Date();

    const dueReminders = reminders.filter(r => {
      if (!r || !r.date) return false;

      const reminderDate = new Date(r.date);

      if (isNaN(reminderDate.getTime())) return false;

      return r.status === 'pending' && reminderDate <= now;
    });

    res.json(dueReminders);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Error processing due reminders' });
  }
});

module.exports = router;
