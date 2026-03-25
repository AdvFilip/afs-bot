const express = require('express');
const app = express();

const reminderRoutes = require('./routes/reminderRoutes');

const PORT = process.env.PORT;

app.use(express.json());

app.get('/', (req, res) => {
  res.send('AFS Bot API is running');
});

app.use('/reminders', reminderRoutes);

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
