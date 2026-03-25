const express = require('express');
const app = express();
const reminderRoutes = require('./routes/reminderRoutes');

app.use(express.json());
app.use('/reminders', reminderRoutes);

// Access shared reminders array
const { reminders } = require('./routes/reminderRoutes');

// Scheduler (runs every 30 seconds)
setInterval(() => {
  console.log('⏳ Checking due reminders...');

  const now = new Date();

  const due = reminders.filter(r => {
    const reminderDate = new Date(r.date);
    return r.status === 'pending' && reminderDate <= now;
  });

  if (due.length > 0) {
    console.log('🚨 Due reminders:', due);
  } else {
    console.log('✅ No due reminders');
  }

}, 30000);

app.get('/', (req, res) => {
  res.send('AFS Bot API is running');
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
