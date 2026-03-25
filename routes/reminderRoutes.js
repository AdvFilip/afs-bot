// Get due reminders
router.get('/due', (req, res) => {
  const now = new Date();

  const dueReminders = reminders.filter(r => {
    return r.status === 'pending' && new Date(r.date) <= now;
  });

  res.json(dueReminders);
});
