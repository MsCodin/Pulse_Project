const pool = require('../config/db');
const HttpError = require('../utils/HttpError');

async function devAuth(req, res, next) {
  const raw = req.get('X-User-ID');
  if (raw === undefined || raw === '') return next();

  const id = Number(raw);
  if (!Number.isInteger(id) || id < 1) return next(new HttpError(401, 'X-User-ID must be a positive whole number'));

  try {
    const [users] = await pool.query("SELECT user_ID, user_full_name, user_email FROM `Users` WHERE user_ID = ? AND user_status = 'active'", [id]);
    if (!users.length) return next(new HttpError(401, 'X-User-ID does not match an active user'));
    const [roles] = await pool.query('SELECT user_role_name, zone_ID FROM `User_roles` WHERE user_ID = ?', [id]);
    req.user = { ...users[0], roles };
    next();
  } catch (err) {
    next(err);
  }
}

module.exports = { devAuth };
