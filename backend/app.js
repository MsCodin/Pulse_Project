require('dotenv').config();
const express = require('express');
const pool = require('./config/db');

const app = express();
app.use(express.json())

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.listen(process.env.PORT || 3000, () => {
  console.log('Pulse API listening on http://localhost:3000/api');
});