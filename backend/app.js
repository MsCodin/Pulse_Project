require('dotenv').config();
const express = require('express');
const pool = require('./config/db');
const router = require('./router');

const app = express();
app.use(express.json());

app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.use('/api', router);

app.use((req, res) => {
  res.status(404).json({ error: { message: `Cannot ${req.method} ${req.originalUrl}` } });
});

app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({
    error: {
      message: status >= 500 ? 'Internal server error' : err.message,
      ...(err.details !== undefined && { details: err.details })
    }
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Pulse API listening on http://localhost:${port}/api`);
});
