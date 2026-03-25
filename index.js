const express = require('express');
const app = express();

const PORT = process.env.PORT || 8080;

app.get('/', (req, res) => {
  res.send('AFS Bot API is running');
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
