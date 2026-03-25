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
