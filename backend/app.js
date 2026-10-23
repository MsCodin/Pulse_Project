require("dotenv").config();
const express = require("express");
const cors = require("cors");
const pool = require("./config/db");
const { devAuth } = require("./middleware/devAuth");
const { notFound, errorHandler } = require("./middleware/errorHandler");

const app = express();

app.use(cors());
app.use(express.json({ limit: "100kb" }));
app.use(devAuth);

app.get("/api/health", async (req, res, next) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", database: "connected" });
  } catch (err) {
    next(err);
  }
});

app.use("/api", require("./routes"));
app.use(notFound);
app.use(errorHandler);

if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () =>
    console.log(`Pulse API listening on http://localhost:${port}/api`),
  );
}

module.exports = app;
