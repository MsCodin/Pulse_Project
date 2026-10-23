const crypto = require('crypto');
const { toMysqlDateTime } = require('./conform');

async function writeAudit(conn, { req, action, entity, entityId = null, before = null, after = null }) {
  const actorId = req && req.user ? req.user.user_ID : null;
  const ip = req ? (req.ip || null) : null;
  const ts = toMysqlDateTime(new Date());
  const beforeJson = before === null ? null : JSON.stringify(before);
  const afterJson = after === null ? null : JSON.stringify(after);

  const [last] = await conn.query('SELECT audit_log_row_hash AS h FROM `Audit_logs` ORDER BY audit_log_ID DESC LIMIT 1 FOR UPDATE');
  const previousHash = last.length ? last[0].h || '' : '';
  const rowHash = crypto.createHash('sha256')
    .update(JSON.stringify([previousHash, actorId, action, entity, entityId, beforeJson, afterJson, ip, ts]))
    .digest('hex');

  await conn.query(
    'INSERT INTO `Audit_logs` (actor_user_ID, audit_log_action, audit_log_entity, audit_log_entity_ID, audit_log_before_json, ' +
    'audit_log_after_json, audit_log_ip_address, audit_log_ts, audit_log_row_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [actorId, action, entity, entityId, beforeJson, afterJson, ip, ts, rowHash]);
}

module.exports = { writeAudit };
