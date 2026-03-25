const express = require('express');
const app = express();

// MUST use Railway's port
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => {
  res.send('AFS Bot API is running');
});

// Bind to all interfaces (important)
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
});
