const express = require('express');
const app = express();

const { router, reminders } = require('./routes/reminderRoutes');

app.use(express.json());
app.use('/reminders', router);

// Scheduler (every 30 seconds)
setInterval(() => {
  console.log('⏳ Checking due reminders...');

  const now = new Date();

  reminders.forEach(r => {
    const reminderDate = new Date(r.date);

    if (
      r.status === 'pending' &&
      reminderDate <= now
    ) {
      console.log('🚨 Triggering reminder:', r);

      // Mark as notified
      r.status = 'notified';
    }
  });

}, 30000);

app.get('/', (req, res) => {
  res.send('AFS Bot API is running');
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
