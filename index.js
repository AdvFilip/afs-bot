const express = require('express');
const app = express();
const reminderRoutes = require('./routes/reminderRoutes');

app.use(express.json());
app.use('/reminders', reminderRoutes);

// Simple scheduler (runs every 30 seconds)
setInterval(() => {
  console.log('⏳ Checking due reminders...');

  // NOTE: This is placeholder for now
  // Later we will connect actual logic here

}, 30000);

app.get('/', (req, res) => {
  res.send('AFS Bot API is running');
});

const PORT = process.env.PORT || 8080;

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
