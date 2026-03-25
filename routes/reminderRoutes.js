// Get due reminders (safe version)
router.get('/due', (req, res) => {
  try {
    const now = new Date();

    const dueReminders = reminders.filter(r => {
      if (!r.date) return false;

      const reminderDate = new Date(r.date);

      if (isNaN(reminderDate)) return false;

      return r.status === 'pending' && reminderDate <= now;
    });

    res.json(dueReminders);

  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Error processing due reminders" });
  }
});
