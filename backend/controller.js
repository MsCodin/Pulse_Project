const pool = require('./config/db');
const HttpError = require('./utils/HttpError');
const asyncHandler = require('./utils/asyncHandler');
const { validateBody, coerceQueryValue } = require('./utils/validate');
const { toDbValue, rowFromDb, toMysqlDateTime } = require('./utils/conform');
const { writeAudit } = require('./utils/audit');

const q = (identifier) => '`' + identifier + '`';
const escapeLike = (s) => s.replace(/[\\%_]/g, '\\$&');
const nowIso = () => new Date().toISOString();
const sqlNow = () => toMysqlDateTime(new Date());
const sqlTime = (iso) => toMysqlDateTime(new Date(iso));
const bad = (field, message) => new HttpError(400, 'Validation failed', [{ field, message }]);

function needUser(req) {
  if (!req.user) throw new HttpError(401, 'Send an X-User-ID header (temporary login until JWT auth is added)');
  return req.user.user_ID;
}

function createCrud(resource) {
  const { table, fields } = resource;
  const hooks = resource.hooks || {};
  const audited = resource.audit !== false;
  const geo = resource.geo;
  const keys = [].concat(resource.pk);
  const composite = keys.length > 1;
  const autoKey = !composite && resource.autoKey !== false;
  const keyType = (k) => (fields[k] && fields[k].type) || 'int';

  const outputNames = [...new Set([...keys, ...Object.keys(fields).filter((n) => !fields[n].virtual && !fields[n].hidden)])];
  const selectCols = outputNames.map((n) => (fields[n] && fields[n].sqlOut ? fields[n].sqlOut(q(n)) : q(n))).join(', ');
  const filterable = resource.filterable || [];
  const sortable = new Set(resource.sortable || outputNames.filter((n) => !(fields[n] && ['polygon', 'json'].includes(fields[n].type))));
  const writableOnReplace = Object.keys(fields).filter(
    (n) => !fields[n].readOnly && !fields[n].virtual && !fields[n].immutable && !fields[n].createOnly);
  const whereKeys = keys.map((k) => `${q(k)} = ?`).join(' AND ');

  function keyValues(req) {
    const out = {};
    for (const k of keys) {
      const raw = composite ? req.params[k] : req.params.id;
      if (keyType(k) === 'string') { out[k] = raw; continue; }
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${composite ? k : 'id'} in the URL must be a positive whole number`);
      out[k] = n;
    }
    return out;
  }

  function scopeFromParams(req) {
    const scope = {};
    for (const [name, raw] of Object.entries(req.params)) {
      if (name === 'id' || !(name in fields || keys.includes(name))) continue;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) throw new HttpError(400, `${name} in the URL must be a positive whole number`);
      scope[name] = n;
    }
    return scope;
  }

  async function findByKeys(vals, conn = pool) {
    const [rows] = await conn.query(`SELECT ${selectCols} FROM ${q(table)} WHERE ${whereKeys}`, keys.map((k) => vals[k]));
    return rows.length ? rowFromDb(rows[0], fields, keys) : null;
  }
  const findById = (id, conn) => findByKeys({ [keys[0]]: id }, conn);
  const pointWkt = (lat, lon) => `POINT(${lon} ${lat})`;
  const notFound = () => new HttpError(404, `${resource.name} record not found`);

  async function inTransaction(work) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const result = await work(conn);
      await conn.commit();
      return result;
    } catch (err) {
      await conn.rollback();
      throw err;
    } finally {
      conn.release();
    }
  }

  const create = asyncHandler(async (req, res) => {
    const scope = scopeFromParams(req);
    let body = req.body;
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      body = { ...body };
      for (const [name, value] of Object.entries(scope)) {
        if (body[name] !== undefined && body[name] !== value) throw bad(name, 'does not match the id in the URL');
        body[name] = value;
      }
    }
    const { errors, data } = validateBody(body, resource, 'create');
    if (errors.length) throw new HttpError(400, 'Validation failed', errors);

    const created = await inTransaction(async (conn) => {
      const ctx = { req, conn };
      if (hooks.beforeCreate) await hooks.beforeCreate(data, ctx);

      const cols = Object.keys(data).filter((k) => fields[k] && !fields[k].virtual);
      const colSql = cols.map(q);
      const marks = cols.map((k) => fields[k].sqlIn || '?');
      const params = cols.map((k) => toDbValue(fields[k].type, data[k]));
      if (geo) { colSql.push(q(geo.column)); marks.push('ST_GeomFromText(?)'); params.push(pointWkt(data[geo.lat], data[geo.lon])); }

      const [result] = await conn.query(
        `INSERT INTO ${q(table)} (${colSql.join(', ')}) VALUES (${marks.join(', ')})`, params);
      const keyVals = autoKey ? { [keys[0]]: result.insertId } : Object.fromEntries(keys.map((k) => [k, data[k]]));
      if (hooks.afterCreate) await hooks.afterCreate(autoKey ? result.insertId : keyVals, data, ctx);
      const row = await findByKeys(keyVals, conn);
      if (audited) await writeAudit(conn, { req, action: 'create', entity: table, entityId: autoKey ? result.insertId : null, after: row });
      return row;
    });
    if (!composite && resource.path) res.location(`/api${resource.path}/${created[keys[0]]}`);
    res.status(201).json({ data: created });
  });

  const read = asyncHandler(async (req, res) => {
    const record = await findByKeys(keyValues(req));
    if (!record) throw notFound();
    res.json({ data: record });
  });

  const makeUpdate = (mode) => asyncHandler(async (req, res) => {
    const vals = keyValues(req);
    const { errors, data } = validateBody(req.body, resource, mode);
    if (errors.length) throw new HttpError(400, 'Validation failed', errors);
    const existing = await findByKeys(vals);
    if (!existing) throw notFound();

    if (mode === 'replace') {
      for (const name of writableOnReplace) if (data[name] === undefined && fields[name].nullable) data[name] = null;
    }

    const updated = await inTransaction(async (conn) => {
      const ctx = { req, conn, existing };
      if (hooks.beforeUpdate) await hooks.beforeUpdate(data, ctx);

      const cols = Object.keys(data).filter((k) => fields[k] && !fields[k].virtual);
      const sets = cols.map((k) => `${q(k)} = ${fields[k].sqlIn || '?'}`);
      const params = cols.map((k) => toDbValue(fields[k].type, data[k]));
      if (geo && (data[geo.lat] !== undefined || data[geo.lon] !== undefined)) {
        sets.push(`${q(geo.column)} = ST_GeomFromText(?)`);
        params.push(pointWkt(data[geo.lat] ?? existing[geo.lat], data[geo.lon] ?? existing[geo.lon]));
      }
      if (sets.length === 0) throw new HttpError(400, 'No updatable fields were supplied');

      await conn.query(`UPDATE ${q(table)} SET ${sets.join(', ')} WHERE ${whereKeys}`, [...params, ...keys.map((k) => vals[k])]);
      if (hooks.afterUpdate) await hooks.afterUpdate(data, ctx);
      const row = await findByKeys(vals, conn);
      if (audited) await writeAudit(conn, { req, action: 'update', entity: table, entityId: autoKey ? existing[keys[0]] : null, before: existing, after: row });
      return row;
    });
    res.json({ data: updated });
  });

  const remove = asyncHandler(async (req, res) => {
    const vals = keyValues(req);
    const existing = await findByKeys(vals);
    if (!existing) throw notFound();
    await inTransaction(async (conn) => {
      await conn.query(`DELETE FROM ${q(table)} WHERE ${whereKeys}`, keys.map((k) => vals[k]));
      if (audited) await writeAudit(conn, { req, action: 'delete', entity: table, entityId: autoKey ? existing[keys[0]] : null, before: existing });
    });
    res.status(204).end();
  });

  const list = asyncHandler(async (req, res) => {
    const where = [];
    const params = [];

    for (const [name, value] of Object.entries(scopeFromParams(req))) { where.push(`${q(name)} = ?`); params.push(value); }

    for (const name of filterable) {
      const def = fields[name] || { type: 'int' };
      if (req.query[name] !== undefined) {
        const values = String(req.query[name]).split(',').map((raw) => coerceQueryValue(def, raw));
        if (values.some((v) => v === undefined)) throw new HttpError(400, `Invalid value for filter '${name}'`);
        const dbValues = values.map((v) => toDbValue(def.type, v));
        if (dbValues.length === 1) { where.push(`${q(name)} = ?`); params.push(dbValues[0]); }
        else { where.push(`${q(name)} IN (?)`); params.push(dbValues); }
      }
      if (['int', 'decimal', 'datetime', 'date'].includes(def.type)) {
        for (const [suffix, op] of [['_gte', '>='], ['_lte', '<=']]) {
          const raw = req.query[name + suffix];
          if (raw === undefined) continue;
          const v = coerceQueryValue(def, String(raw));
          if (v === undefined) throw new HttpError(400, `Invalid value for filter '${name}${suffix}'`);
          where.push(`${q(name)} ${op} ?`);
          params.push(toDbValue(def.type, v));
        }
      }
    }
    for (const [key, build] of Object.entries(resource.customFilters || {})) {
      if (req.query[key] === undefined) continue;
      const piece = build(String(req.query[key]));
      if (piece === undefined) throw new HttpError(400, `Invalid value for filter '${key}'`);
      where.push(piece.sql);
      params.push(...piece.params);
    }
    if (resource.searchable && req.query.q) {
      where.push('(' + resource.searchable.map((c) => `${q(c)} LIKE ?`).join(' OR ') + ')');
      resource.searchable.forEach(() => params.push(`%${escapeLike(String(req.query.q))}%`));
    }

    const sortSpec = req.query.sort ? String(req.query.sort).split(',') : (resource.defaultSort || keys);
    const orderBy = sortSpec.map((part) => {
      const desc = part.startsWith('-');
      const col = desc ? part.slice(1) : part;
      if (!sortable.has(col)) throw new HttpError(400, `Cannot sort by '${col}'`);
      return `${q(col)} ${desc ? 'DESC' : 'ASC'}`;
    }).join(', ');

    const page = req.query.page === undefined ? 1 : Number(req.query.page);
    const limit = req.query.limit === undefined ? 20 : Number(req.query.limit);
    if (!Number.isInteger(page) || page < 1) throw new HttpError(400, "'page' must be a positive whole number");
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new HttpError(400, "'limit' must be between 1 and 100");

    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const [rows] = await pool.query(
      `SELECT ${selectCols} FROM ${q(table)}${whereSql} ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]);
    const [[{ total }]] = await pool.query(`SELECT COUNT(*) AS total FROM ${q(table)}${whereSql}`, params);
    res.json({
      data: rows.map((r) => rowFromDb(r, fields, keys)),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) }
    });
  });

  return { create, read, update: makeUpdate('replace'), patch: makeUpdate('patch'), remove, list,
           findById, findByKeys, keyValues, inTransaction, allow: resource.allow || ['create', 'read', 'update', 'delete', 'list'] };
}

const bcrypt = require('bcryptjs');

const str  = (max, o = {}) => ({ type: 'string', max, ...o });
const int  = (o = {}) => ({ type: 'int', ...o });
const fk   = (o = {}) => ({ type: 'int', min: 1, ...o });
const dec  = (o = {}) => ({ type: 'decimal', ...o });
const bool = (o = {}) => ({ type: 'boolean', ...o });
const en   = (values, o = {}) => ({ type: 'enum', values, ...o });
const dt   = (o = {}) => ({ type: 'datetime', ...o });
const day  = (o = {}) => ({ type: 'date', ...o });
const json = (o = {}) => ({ type: 'json', ...o });
const sys  = (type, extra = {}) => ({ type, readOnly: true, ...extra });
const ref  = (o = {}) => fk({ required: true, immutable: true, ...o });
const optRef = (o = {}) => fk({ nullable: true, immutable: true, ...o });
const link = (o = {}) => fk({ nullable: true, ...o });
const stamp = () => nowIso();

const ROLE_NAMES = ['Reporter', 'Dispatcher', 'Field Responder', 'Site Coordinator', 'Shift Supervisor', 'Resource Manager', 'Analyst', 'System Admin'];
const CLASSIFICATIONS = ['emergency', 'non_emergency', 'information_only'];
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const SEVERITY_RANK = { low: 1, medium: 2, high: 3, critical: 4 };
const INCIDENT_STATUSES = ['reported', 'triaged', 'matched', 'accepted', 'en_route', 'on_scene', 'resolved', 'closed', 'escalated', 'reopened'];
const ASSIGNMENT_STATUSES = ['offered', 'accepted', 'declined', 'timed_out', 'en_route', 'on_scene', 'resolved', 'reassigned', 'cancelled'];

function assertOrder(earlier, later, field, message) {
  if (earlier && later && Date.parse(later) <= Date.parse(earlier)) throw bad(field, message);
}
function forbidOnCreate(data, names) {
  for (const n of names) if (data[n] !== undefined) throw bad(n, 'cannot be set when creating - it is set later in the workflow');
}

async function assertOnShift(conn, shiftId, responderId, whenIso, field) {
  const [rows] = await conn.query(
    'SELECT 1 FROM `Shift_assignments` sa JOIN `Shifts` s ON s.shift_ID = sa.shift_ID ' +
    'WHERE sa.shift_ID = ? AND sa.responder_ID = ? AND s.shift_start_ts <= ? AND s.shift_end_ts >= ? LIMIT 1',
    [shiftId, responderId, sqlTime(whenIso), sqlTime(whenIso)]);
  if (!rows.length) throw new HttpError(422, `${field}: the responder is not rostered on that shift at that time`);
}

async function computePriority(conn, zoneId, categoryId, severity) {
  const [rows] = await conn.query(
    'SELECT zone_priority_rule_weight AS w FROM `Zone_priority_rules` WHERE zone_ID = ? AND incident_category_ID = ?', [zoneId, categoryId]);
  return Math.round(SEVERITY_RANK[severity] * (rows.length ? Number(rows[0].w) : 1) * 100) / 100;
}
async function secondApprovalThreshold(conn) {
  const [rows] = await conn.query("SELECT system_setting_value AS v FROM `System_settings` WHERE system_setting_key = 'work_order_second_approval_cost'");
  return rows.length ? Number(rows[0].v) : 1000;
}

const defs = {};

defs.users = {
  name: 'users', table: 'Users', pk: 'user_ID', path: '/users',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    user_full_name:         str(100, { required: true }),
    user_email:             { type: 'email', required: true, max: 100 },
    user_phone:             str(20, { nullable: true }),
    password:               str(72, { required: true, min: 8, virtual: true, createOnly: true }),
    user_password_hash:     sys('string', { hidden: true }),
    user_mfa_secret:        sys('string', { hidden: true }),
    user_status:            sys('enum', { values: ['active', 'deactivated'] }),
    user_created_at:        sys('datetime'),
    user_last_login_at:     sys('datetime'),
    user_deactivated_at:    sys('datetime'),
    deactivated_by_user_ID: sys('int')
  },
  filterable: ['user_status', 'user_email'],
  searchable: ['user_full_name', 'user_email'],
  defaultSort: ['user_full_name'],
  hooks: {
    async beforeCreate(data) {
      data.user_password_hash = await bcrypt.hash(data.password, 10);
      data.user_status = 'active';
      data.user_created_at = stamp();
    }
  }
};

defs.userRoles = {
  name: 'user-roles', table: 'User_roles', pk: 'user_role_ID', path: '/user-roles',
  fields: {
    user_ID:        ref(),
    user_role_name: en(ROLE_NAMES, { required: true, immutable: true }),
    zone_ID:        optRef()
  },
  filterable: ['user_ID', 'user_role_name', 'zone_ID'],
  defaultSort: ['user_ID', 'user_role_name']
};

defs.loginAttempts = {
  name: 'login-attempts', table: 'Login_attempts', pk: 'login_attempt_ID', path: '/login-attempts', audit: false,
  allow: ['read', 'list'],
  fields: {
    login_attempt_email:      sys('string'),
    user_ID:                  sys('int'),
    login_attempt_success:    sys('boolean'),
    login_attempt_ip_address: sys('string'),
    login_attempt_at:         sys('datetime')
  },
  filterable: ['user_ID', 'login_attempt_email', 'login_attempt_success', 'login_attempt_ip_address', 'login_attempt_at'],
  defaultSort: ['-login_attempt_at']
};

defs.zones = {
  name: 'zones', table: 'Zones', pk: 'zone_ID', path: '/zones',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    zone_name:      str(60, { required: true }),

    zone_boundary:  { type: 'polygon', required: true, sqlIn: 'ST_GeomFromText(?)', sqlOut: (c) => `ST_AsText(${c}) AS ${c}` },
    zone_is_active: bool({ default: true })
  },
  filterable: ['zone_name', 'zone_is_active'],
  searchable: ['zone_name'],
  defaultSort: ['zone_name']
};

defs.sites = {
  name: 'sites', table: 'Sites', pk: 'site_ID', path: '/sites',
  allow: ['create', 'read', 'update', 'list'],
  geo: { column: 'site_geo', lat: 'site_latitude', lon: 'site_longitude' },
  fields: {
    site_name:      str(100, { required: true }),
    site_type:      en(['station', 'premises', 'hydrant'], { required: true }),
    site_address:   str(150, { required: true }),
    site_latitude:  dec({ required: true, min: -90, max: 90 }),
    site_longitude: dec({ required: true, min: -180, max: 180 }),
    zone_ID:        fk({ required: true }),
    site_is_active: bool({ default: true })
  },
  filterable: ['site_type', 'zone_ID', 'site_is_active'],
  searchable: ['site_name', 'site_address'],
  defaultSort: ['site_name']
};

defs.responders = {
  name: 'responders', table: 'Responders', pk: 'responder_ID', path: '/responders',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    user_ID:                ref(),
    responder_callsign:     str(20, { required: true }),
    station_site_ID:        fk({ required: true }),
    responder_availability: en(['available', 'on_task', 'on_break', 'out_of_service'], { default: 'available' }),
    responder_latitude:     sys('decimal'),
    responder_longitude:    sys('decimal'),
    responder_last_ping_at: sys('datetime')
  },
  filterable: ['user_ID', 'responder_callsign', 'station_site_ID', 'responder_availability'],
  searchable: ['responder_callsign'],
  defaultSort: ['responder_callsign']
};

defs.responderLocations = {
  name: 'responder-locations', table: 'Responder_locations', pk: 'responder_location_ID', path: '/responder-locations', audit: false,
  allow: ['create', 'read', 'list'],
  fields: {
    responder_location_recorded_at: dt({ default: stamp, immutable: true }),
    responder_ID:                   ref(),
    responder_location_latitude:    dec({ required: true, immutable: true, min: -90, max: 90 }),
    responder_location_longitude:   dec({ required: true, immutable: true, min: -180, max: 180 }),
    responder_location_speed_kmh:   dec({ nullable: true, immutable: true, min: 0, max: 999.9 }),
    responder_location_heading_deg: int({ nullable: true, immutable: true, min: 0, max: 359 }),
    assignment_ID:                  optRef()
  },
  filterable: ['responder_ID', 'assignment_ID', 'responder_location_recorded_at'],
  defaultSort: ['-responder_location_recorded_at'],
  hooks: {
    async beforeCreate(data, { conn }) {
      const [rows] = await conn.query('SELECT 1 FROM `Responders` WHERE responder_ID = ?', [data.responder_ID]);
      if (!rows.length) throw new HttpError(422, 'responder_ID does not match a responder');
    },
    async afterCreate(id, data, { conn }) {
      await conn.query(
        'UPDATE `Responders` SET responder_latitude = ?, responder_longitude = ?, responder_last_ping_at = ? ' +
        'WHERE responder_ID = ? AND (responder_last_ping_at IS NULL OR responder_last_ping_at <= ?)',
        [data.responder_location_latitude, data.responder_location_longitude, sqlTime(data.responder_location_recorded_at),
         data.responder_ID, sqlTime(data.responder_location_recorded_at)]);
    }
  }
};

defs.skills = {
  name: 'skills', table: 'Skills', pk: 'skill_ID', path: '/skills',
  fields: { skill_name: str(60, { required: true }) },
  filterable: ['skill_name'], searchable: ['skill_name'], defaultSort: ['skill_name']
};

defs.responderSkills = {
  name: 'responder-skills', table: 'Responder_skills', pk: 'responder_skill_ID', path: '/responder-skills',
  fields: {
    responder_ID:                       ref(),
    skill_ID:                           ref(),
    responder_skill_issued_at:          day({ required: true }),
    responder_skill_expires_at:         day({ required: true }),
    responder_skill_certificate_ref:    str(50, { nullable: true }),
    responder_skill_expiry_notified_at: sys('datetime'),
    recorded_by_user_ID:                sys('int')
  },
  filterable: ['responder_ID', 'skill_ID', 'responder_skill_expires_at'],
  defaultSort: ['responder_skill_expires_at'],
  hooks: {
    async beforeCreate(data, { req }) {
      assertOrder(data.responder_skill_issued_at, data.responder_skill_expires_at, 'responder_skill_expires_at', 'must be after the issue date');
      data.recorded_by_user_ID = needUser(req);
    },
    async beforeUpdate(data, { req, existing }) {
      const m = { ...existing, ...data };
      assertOrder(m.responder_skill_issued_at, m.responder_skill_expires_at, 'responder_skill_expires_at', 'must be after the issue date');
      if (data.responder_skill_expires_at && data.responder_skill_expires_at !== existing.responder_skill_expires_at) {
        data.responder_skill_expiry_notified_at = null;
      }
      data.recorded_by_user_ID = needUser(req);
    }
  }
};

defs.equipmentTypes = {
  name: 'equipment-types', table: 'Equipment_types', pk: 'equipment_type_ID', path: '/equipment-types',
  fields: { equipment_type_name: str(60, { required: true }) },
  filterable: ['equipment_type_name'], searchable: ['equipment_type_name'], defaultSort: ['equipment_type_name']
};

defs.equipment = {
  name: 'equipment', table: 'Equipment', pk: 'equipment_ID', path: '/equipment',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    equipment_type_ID:       fk({ required: true }),
    equipment_serial_number: str(50, { required: true }),
    equipment_status:        en(['in_service', 'allocated', 'faulty', 'under_repair', 'retired'], { default: 'in_service' }),
    home_site_ID:            fk({ required: true })
  },
  filterable: ['equipment_type_ID', 'equipment_status', 'home_site_ID', 'equipment_serial_number'],
  searchable: ['equipment_serial_number'],
  defaultSort: ['equipment_serial_number']
};

defs.equipmentAllocations = {
  name: 'equipment-allocations', table: 'Equipment_allocations', pk: 'equipment_allocation_ID', path: '/equipment-allocations',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    equipment_ID:                     ref(),
    responder_ID:                     optRef(),
    work_order_ID:                    optRef(),
    equipment_allocation_from:        dt({ required: true, immutable: true }),
    equipment_allocation_to:          dt({ required: true }),
    equipment_allocation_returned_at: dt({ nullable: true }),
    allocated_by_user_ID:             sys('int')
  },
  filterable: ['equipment_ID', 'responder_ID', 'work_order_ID', 'equipment_allocation_from', 'equipment_allocation_to', 'equipment_allocation_returned_at'],
  defaultSort: ['-equipment_allocation_from'],
  hooks: {
    async beforeCreate(data, { req, conn }) {
      if ((data.responder_ID != null) === (data.work_order_ID != null)) throw bad('responder_ID', 'give exactly one of responder_ID and work_order_ID');
      assertOrder(data.equipment_allocation_from, data.equipment_allocation_to, 'equipment_allocation_to', 'must be after equipment_allocation_from');
      const [eq] = await conn.query('SELECT equipment_status FROM `Equipment` WHERE equipment_ID = ?', [data.equipment_ID]);
      if (!eq.length) throw new HttpError(422, 'equipment_ID does not match any equipment');
      if (['faulty', 'under_repair', 'retired'].includes(eq[0].equipment_status)) {
        throw new HttpError(409, `This equipment is ${eq[0].equipment_status} and cannot be allocated`);
      }

      const [clash] = await conn.query(
        'SELECT equipment_allocation_ID FROM `Equipment_allocations` WHERE equipment_ID = ? AND equipment_allocation_from < ? ' +
        'AND COALESCE(equipment_allocation_returned_at, equipment_allocation_to) > ? LIMIT 1',
        [data.equipment_ID, sqlTime(data.equipment_allocation_to), sqlTime(data.equipment_allocation_from)]);
      if (clash.length) throw new HttpError(409, 'This equipment is already allocated for part of that period', { clashing_allocation_ID: clash[0].equipment_allocation_ID });
      data.allocated_by_user_ID = needUser(req);
    },
    async beforeUpdate(data, { existing }) {
      const m = { ...existing, ...data };
      assertOrder(m.equipment_allocation_from, m.equipment_allocation_to, 'equipment_allocation_to', 'must be after equipment_allocation_from');
      if (data.equipment_allocation_returned_at) {
        assertOrder(m.equipment_allocation_from, m.equipment_allocation_returned_at, 'equipment_allocation_returned_at', 'must be after equipment_allocation_from');
      }
    }
  }
};

defs.equipmentFaults = {
  name: 'equipment-faults', table: 'Equipment_faults', pk: 'equipment_fault_ID', path: '/equipment-faults',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    equipment_ID:                ref(),
    reporter_responder_ID:       ref(),
    incident_ID:                 optRef(),
    equipment_fault_description: str(255, { required: true }),
    equipment_fault_reported_at: sys('datetime'),
    equipment_fault_status:      en(['open', 'resolved'], { default: 'open' }),
    equipment_fault_resolved_at: sys('datetime')
  },
  filterable: ['equipment_ID', 'reporter_responder_ID', 'incident_ID', 'equipment_fault_status'],
  defaultSort: ['-equipment_fault_reported_at'],
  hooks: {
    async beforeCreate(data) { data.equipment_fault_reported_at = stamp(); data.equipment_fault_status = 'open'; },
    async afterCreate(id, data, { conn }) {
      await conn.query("UPDATE `Equipment` SET equipment_status = 'faulty' WHERE equipment_ID = ? AND equipment_status IN ('in_service', 'allocated')", [data.equipment_ID]);
    },
    async beforeUpdate(data, { existing }) {
      if (data.equipment_fault_status === 'open' && existing.equipment_fault_status === 'resolved') throw new HttpError(409, 'A resolved fault cannot be reopened - report a new fault');
      if (data.equipment_fault_status === 'resolved' && existing.equipment_fault_status === 'open') data.equipment_fault_resolved_at = stamp();
    },
    async afterUpdate(data, { conn, existing }) {
      if (data.equipment_fault_status !== 'resolved' || existing.equipment_fault_status === 'resolved') return;
      const [[{ open }]] = await conn.query("SELECT COUNT(*) AS open FROM `Equipment_faults` WHERE equipment_ID = ? AND equipment_fault_status = 'open'", [existing.equipment_ID]);
      if (open === 0) await conn.query("UPDATE `Equipment` SET equipment_status = 'in_service' WHERE equipment_ID = ? AND equipment_status = 'faulty'", [existing.equipment_ID]);
    }
  }
};

defs.equipmentMaintenanceLogs = {
  name: 'equipment-maintenance-logs', table: 'Equipment_maintenance_logs', pk: 'equipment_maintenance_log_ID', path: '/equipment-maintenance-logs', audit: false,
  allow: ['create', 'read', 'list'],
  fields: {
    equipment_ID:                         ref(),
    equipment_fault_ID:                   optRef(),
    equipment_maintenance_log_event_type: en(['service', 'inspection', 'repair', 'replacement'], { required: true, immutable: true }),
    equipment_maintenance_log_notes:      str(255, { required: true, immutable: true }),
    performed_by_user_ID:                 sys('int'),
    equipment_maintenance_log_event_at:   dt({ default: stamp, immutable: true })
  },
  filterable: ['equipment_ID', 'equipment_fault_ID', 'equipment_maintenance_log_event_type', 'equipment_maintenance_log_event_at'],
  defaultSort: ['-equipment_maintenance_log_event_at'],
  hooks: { async beforeCreate(data, { req }) { data.performed_by_user_ID = needUser(req); } }
};

defs.shifts = {
  name: 'shifts', table: 'Shifts', pk: 'shift_ID', path: '/shifts',
  fields: {
    zone_ID:            ref(),
    shift_start_ts:     dt({ required: true }),
    shift_end_ts:       dt({ required: true }),
    shift_min_cover:    int({ required: true, min: 0, max: 1000 }),
    created_by_user_ID: sys('int')
  },
  filterable: ['zone_ID', 'shift_start_ts', 'shift_end_ts'],
  defaultSort: ['shift_start_ts'],
  hooks: {
    async beforeCreate(data, { req }) {
      assertOrder(data.shift_start_ts, data.shift_end_ts, 'shift_end_ts', 'must be after shift_start_ts');
      data.created_by_user_ID = needUser(req);
    },
    async beforeUpdate(data, { existing }) {
      const m = { ...existing, ...data };
      assertOrder(m.shift_start_ts, m.shift_end_ts, 'shift_end_ts', 'must be after shift_start_ts');
    }
  }
};

defs.shiftSkillCovers = {
  name: 'shift-skill-covers', table: 'Shift_skill_covers', pk: ['shift_ID', 'skill_ID'],
  fields: {
    shift_ID:                    ref(),
    skill_ID:                    ref(),
    shift_skill_cover_min_cover: int({ required: true, min: 0, max: 1000 })
  },
  filterable: ['shift_ID', 'skill_ID'], defaultSort: ['shift_ID', 'skill_ID']
};

defs.shiftAssignments = {
  name: 'shift-assignments', table: 'Shift_assignments', pk: 'shift_assignment_ID', path: '/shift-assignments',
  fields: {
    shift_ID:                ref(),
    responder_ID:            ref(),
    shift_assignment_status: en(['scheduled', 'on_duty', 'completed', 'absent'], { default: 'scheduled' }),
    assigned_by_user_ID:     sys('int')
  },
  filterable: ['shift_ID', 'responder_ID', 'shift_assignment_status'],
  defaultSort: ['shift_ID', 'responder_ID'],
  hooks: {
    async beforeCreate(data, { req, conn }) {
      const [clash] = await conn.query(
        'SELECT sa.shift_ID FROM `Shift_assignments` sa JOIN `Shifts` s ON s.shift_ID = sa.shift_ID JOIN `Shifts` n ON n.shift_ID = ? ' +
        'WHERE sa.responder_ID = ? AND s.shift_start_ts < n.shift_end_ts AND s.shift_end_ts > n.shift_start_ts LIMIT 1',
        [data.shift_ID, data.responder_ID]);
      if (clash.length) throw new HttpError(409, 'This responder is already on an overlapping shift', { clashing_shift_ID: clash[0].shift_ID });
      data.assigned_by_user_ID = needUser(req);
    }
  }
};

const BOOKING_MOVES = {
  requested: ['approved', 'rejected', 'cancelled'],
  approved:  ['scheduled', 'cancelled'],
  scheduled: ['preempted', 'completed', 'cancelled'],
  preempted: ['scheduled', 'cancelled'],
  rejected: [], completed: [], cancelled: []
};
defs.bookings = {
  name: 'bookings', table: 'Bookings', pk: 'booking_ID', path: '/bookings',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    requested_by_user_ID:     sys('int'),
    site_ID:                  ref(),
    incident_ID:              optRef(),
    booking_type:             en(['inspection', 'drill', 'hydrant_check', 'other'], { required: true, immutable: true }),
    booking_window_start:     dt({ required: true, immutable: true }),
    booking_window_end:       dt({ required: true, immutable: true }),
    booking_status:           en(['requested', 'approved', 'rejected', 'scheduled', 'preempted', 'completed', 'cancelled']),
    decided_by_user_ID:       sys('int'),
    booking_decision_reason:  str(255, { nullable: true }),
    booking_scheduled_start:  dt({ nullable: true }),
    booking_scheduled_end:    dt({ nullable: true }),
    scheduled_shift_ID:       link(),
    scheduled_responder_ID:   link(),
    scheduled_by_user_ID:     sys('int'),
    preempted_by_incident_ID: link(),
    booking_preempted_at:     sys('datetime')
  },
  filterable: ['site_ID', 'requested_by_user_ID', 'incident_ID', 'booking_type', 'booking_status', 'scheduled_shift_ID', 'scheduled_responder_ID', 'booking_window_start'],
  defaultSort: ['booking_window_start'],
  hooks: {
    async beforeCreate(data, { req }) {
      forbidOnCreate(data, ['booking_decision_reason', 'booking_scheduled_start', 'booking_scheduled_end', 'scheduled_shift_ID',
                            'scheduled_responder_ID', 'preempted_by_incident_ID', 'booking_status']);
      assertOrder(data.booking_window_start, data.booking_window_end, 'booking_window_end', 'must be after booking_window_start');
      data.requested_by_user_ID = needUser(req);
      data.booking_status = 'requested';
    },

    async beforeUpdate(data, { req, conn, existing }) {
      const m = { ...existing, ...data };
      const next = data.booking_status;
      if (!next || next === existing.booking_status) return;
      if (!BOOKING_MOVES[existing.booking_status].includes(next)) {
        throw new HttpError(409, `A booking cannot move from '${existing.booking_status}' to '${next}'`, { allowed: BOOKING_MOVES[existing.booking_status] });
      }
      if (next === 'approved' || next === 'rejected') {
        data.decided_by_user_ID = needUser(req);
        if (next === 'rejected' && !m.booking_decision_reason) throw bad('booking_decision_reason', 'is required when rejecting a booking');
      }
      if (next === 'scheduled') {
        for (const f of ['booking_scheduled_start', 'booking_scheduled_end', 'scheduled_shift_ID', 'scheduled_responder_ID']) {
          if (m[f] == null) throw bad(f, 'is required when scheduling a booking');
        }
        assertOrder(m.booking_scheduled_start, m.booking_scheduled_end, 'booking_scheduled_end', 'must be after booking_scheduled_start');
        await assertOnShift(conn, m.scheduled_shift_ID, m.scheduled_responder_ID, m.booking_scheduled_start, 'scheduled_responder_ID');
        data.scheduled_by_user_ID = needUser(req);
      }
      if (next === 'preempted') {
        if (m.preempted_by_incident_ID == null) throw bad('preempted_by_incident_ID', 'is required when a booking is pre-empted');
        data.booking_preempted_at = stamp();
      }
    }
  }
};

defs.incidentCategories = {
  name: 'incident-categories', table: 'Incident_categories', pk: 'incident_category_ID', path: '/incident-categories',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    incident_category_name:                   str(60, { required: true }),
    incident_category_default_classification: en(CLASSIFICATIONS, { required: true }),
    incident_category_default_severity:       en(SEVERITIES, { required: true }),
    incident_category_min_responders:         int({ required: true, min: 1, max: 100 }),
    incident_category_sla_response_mins:      int({ nullable: true, min: 1 }),
    incident_category_is_active:              bool({ default: true })
  },
  filterable: ['incident_category_name', 'incident_category_default_classification', 'incident_category_default_severity', 'incident_category_is_active'],
  searchable: ['incident_category_name'],
  defaultSort: ['incident_category_name']
};

defs.categoryRequiredSkills = {
  name: 'category-required-skills', table: 'Category_required_skills', pk: ['incident_category_ID', 'skill_ID'],
  allow: ['create', 'read', 'delete', 'list'],
  fields: { incident_category_ID: ref(), skill_ID: ref() },
  filterable: ['incident_category_ID', 'skill_ID'], defaultSort: ['incident_category_ID', 'skill_ID']
};

defs.categoryRequiredEquipment = {
  name: 'category-required-equipment', table: 'Category_required_equipment', pk: ['incident_category_ID', 'equipment_type_ID'],
  fields: {
    incident_category_ID:                 ref(),
    equipment_type_ID:                    ref(),
    category_required_equipment_quantity: int({ required: true, min: 1, max: 1000 })
  },
  filterable: ['incident_category_ID', 'equipment_type_ID'], defaultSort: ['incident_category_ID', 'equipment_type_ID']
};

defs.incidents = {
  name: 'incidents', table: 'Incidents', pk: 'incident_ID', path: '/incidents',
  allow: ['create', 'read', 'update', 'list'],
  geo: { column: 'incident_geo', lat: 'incident_latitude', lon: 'incident_longitude' },
  fields: {
    reporter_user_ID:         sys('int'),
    incident_category_ID:     ref(),
    zone_ID:                  sys('int'),
    site_ID:                  link(),
    incident_classification:  en(CLASSIFICATIONS),
    incident_severity:        en(SEVERITIES),
    incident_priority_score:  sys('decimal'),
    incident_status:          sys('enum', { values: INCIDENT_STATUSES }),
    incident_location:        str(150, { required: true, immutable: true }),
    incident_latitude:        dec({ required: true, immutable: true, min: -90, max: 90 }),
    incident_longitude:       dec({ required: true, immutable: true, min: -180, max: 180 }),
    incident_description:     str(500, { required: true }),
    incident_reported_at:     sys('datetime'),
    incident_response_due_at: sys('datetime'),
    incident_closed_at:       sys('datetime'),
    incident_reopened_count:  sys('int')
  },
  filterable: ['zone_ID', 'incident_category_ID', 'site_ID', 'reporter_user_ID', 'incident_classification', 'incident_severity', 'incident_status', 'incident_reported_at'],
  searchable: ['incident_location', 'incident_description'],
  defaultSort: ['-incident_priority_score', 'incident_reported_at'],
  customFilters: {
    open: (v) => v === 'true' ? { sql: 'incident_status NOT IN (?, ?)', params: ['resolved', 'closed'] }
              : v === 'false' ? { sql: 'incident_status IN (?, ?)', params: ['resolved', 'closed'] } : undefined
  },
  hooks: {
    async beforeCreate(data, { req, conn }) {
      data.reporter_user_ID = needUser(req);
      const [cats] = await conn.query(
        'SELECT incident_category_default_classification AS cls, incident_category_default_severity AS sev, incident_category_sla_response_mins AS sla ' +
        'FROM `Incident_categories` WHERE incident_category_ID = ? AND incident_category_is_active = 1', [data.incident_category_ID]);
      if (!cats.length) throw new HttpError(422, 'incident_category_ID does not match an active category');
      data.incident_classification = data.incident_classification || cats[0].cls;
      data.incident_severity = data.incident_severity || cats[0].sev;

      const [zones] = await conn.query(
        'SELECT zone_ID FROM `Zones` WHERE zone_is_active = 1 AND ST_Contains(zone_boundary, ST_GeomFromText(?)) LIMIT 1',
        [`POINT(${data.incident_longitude} ${data.incident_latitude})`]);
      if (!zones.length) throw new HttpError(422, 'These coordinates are outside every active zone');
      data.zone_ID = zones[0].zone_ID;

      const now = new Date();
      data.incident_status = 'reported';
      data.incident_reported_at = now.toISOString();
      data.incident_reopened_count = 0;
      data.incident_priority_score = await computePriority(conn, data.zone_ID, data.incident_category_ID, data.incident_severity);
      data.incident_response_due_at = cats[0].sla === null ? null : new Date(now.getTime() + cats[0].sla * 60000).toISOString();
    },
    async afterCreate(id, data, { req, conn }) {
      await conn.query(
        'INSERT INTO `Status_logs` (incident_ID, status_log_from_status, status_log_to_status, actor_user_ID, status_log_note, status_log_changed_at) VALUES (?, NULL, ?, ?, NULL, ?)',
        [id, 'reported', req.user.user_ID, sqlTime(data.incident_reported_at)]);
    },
    async beforeUpdate(data, { conn, existing }) {
      if (data.incident_severity && data.incident_severity !== existing.incident_severity) {
        data.incident_priority_score = await computePriority(conn, existing.zone_ID, existing.incident_category_ID, data.incident_severity);
      }
    }
  }
};

function checkCallLink(m) {
  const linked = m.incident_ID != null;
  if (linked && m.call_status === 'logged') throw bad('call_status', "a call linked to an incident must be 'filed' or 'linked'");
  if (!linked && m.call_status !== 'logged') throw bad('incident_ID', "is required when call_status is 'filed' or 'linked'");
}
defs.calls = {
  name: 'calls', table: 'Calls', pk: 'call_ID', path: '/calls',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    reporter_user_ID:    sys('int'),
    incident_ID:         link(),
    call_classification: en(CLASSIFICATIONS, { required: true }),
    call_status:         en(['logged', 'filed', 'linked'], { default: 'logged' }),
    call_received_at:    sys('datetime'),
    call_caller_name:    str(100, { nullable: true }),
    call_caller_phone:   str(20, { required: true }),
    call_location:       str(150, { required: true }),
    call_latitude:       dec({ nullable: true, min: -90, max: 90 }),
    call_longitude:      dec({ nullable: true, min: -180, max: 180 }),
    call_summary:        str(255, { required: true })
  },
  filterable: ['reporter_user_ID', 'incident_ID', 'call_classification', 'call_status', 'call_caller_phone', 'call_received_at'],
  searchable: ['call_location', 'call_summary', 'call_caller_name'],
  defaultSort: ['-call_received_at'],
  hooks: {
    async beforeCreate(data, { req }) {
      data.reporter_user_ID = needUser(req);
      data.call_received_at = stamp();
      checkCallLink(data);
    },
    async beforeUpdate(data, { existing }) { checkCallLink({ ...existing, ...data }); }
  }
};

defs.callbackRequests = {
  name: 'callback-requests', table: 'Callback_requests', pk: 'callback_request_ID', path: '/callback-requests',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    call_ID:                       ref(),
    requested_by_user_ID:          sys('int'),
    callback_request_requested_at: sys('datetime'),
    callback_request_reason:       str(255, { required: true }),
    callback_request_status:       en(['pending', 'completed'], { default: 'pending' }),
    callback_request_completed_at: sys('datetime')
  },
  filterable: ['call_ID', 'requested_by_user_ID', 'callback_request_status'],
  defaultSort: ['-callback_request_requested_at'],
  hooks: {
    async beforeCreate(data, { req }) {
      data.requested_by_user_ID = needUser(req);
      data.callback_request_requested_at = stamp();
      data.callback_request_status = 'pending';
    },
    async beforeUpdate(data, { existing }) {
      if (existing.callback_request_status === 'completed') throw new HttpError(409, 'This callback is already completed');
      if (data.callback_request_status === 'completed') data.callback_request_completed_at = stamp();
    }
  }
};

defs.assignments = {
  name: 'assignments', table: 'Assignments', pk: 'assignment_ID', path: '/assignments',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    incident_ID:                ref(),
    responder_ID:               ref(),
    dispatcher_user_ID:         sys('int'),
    assignment_strategy:        en(['greedy', 'batched_hungarian', 'auction', 'manual'], { required: true, immutable: true }),
    assignment_status:          sys('enum', { values: ASSIGNMENT_STATUSES }),
    assignment_assigned_at:     sys('datetime'),
    assignment_responded_at:    sys('datetime'),
    assignment_en_route_at:     sys('datetime'),
    assignment_on_scene_at:     sys('datetime'),
    assignment_resolved_at:     sys('datetime'),
    assignment_decline_reason:  sys('string'),
    assignment_match_score:     dec({ nullable: true, min: 0, max: 9999.99 }),
    assignment_eta_minutes:     int({ nullable: true, min: 0, max: 32767 }),
    assignment_is_override:     bool({ default: false }),
    assignment_override_reason: str(255, { nullable: true }),
    assignment_approval_status: en(['none', 'pending', 'approved', 'denied'], { default: 'none' }),
    approved_by_user_ID:        sys('int'),
    assignment_approval_note:   str(255, { nullable: true })
  },
  filterable: ['incident_ID', 'responder_ID', 'dispatcher_user_ID', 'assignment_strategy', 'assignment_status', 'assignment_approval_status', 'assignment_assigned_at'],
  defaultSort: ['-assignment_assigned_at'],
  hooks: {
    async beforeCreate(data, { req, conn }) {
      if (data.assignment_is_override && !data.assignment_override_reason) throw bad('assignment_override_reason', 'is required when assignment_is_override is true');
      data.dispatcher_user_ID = data.assignment_strategy === 'manual' ? needUser(req) : (req.user ? req.user.user_ID : null);

      const [inc] = await conn.query('SELECT zone_ID, incident_status FROM `Incidents` WHERE incident_ID = ?', [data.incident_ID]);
      if (!inc.length) throw new HttpError(422, 'incident_ID does not match an incident');
      if (['resolved', 'closed'].includes(inc[0].incident_status)) throw new HttpError(409, `The incident is ${inc[0].incident_status}, so no crew can be offered it`);

      const now = sqlNow();
      const [onShift] = await conn.query(
        "SELECT 1 FROM `Shift_assignments` sa JOIN `Shifts` s ON s.shift_ID = sa.shift_ID WHERE sa.responder_ID = ? " +
        "AND sa.shift_assignment_status IN ('scheduled', 'on_duty') AND s.zone_ID = ? AND s.shift_start_ts <= ? AND s.shift_end_ts > ? LIMIT 1",
        [data.responder_ID, inc[0].zone_ID, now, now]);
      data.assignment_approval_status = onShift.length ? 'none' : 'pending';
      data.assignment_status = 'offered';
      data.assignment_assigned_at = stamp();
    },
    async beforeUpdate(data, { req, existing }) {
      const m = { ...existing, ...data };
      if (m.assignment_is_override && !m.assignment_override_reason) throw bad('assignment_override_reason', 'is required when assignment_is_override is true');
      if (data.assignment_approval_status && data.assignment_approval_status !== existing.assignment_approval_status) {
        if (existing.assignment_approval_status !== 'pending') throw new HttpError(409, 'Only a pending assignment can be approved or denied');
        if (!['approved', 'denied'].includes(data.assignment_approval_status)) throw bad('assignment_approval_status', "can only be changed to 'approved' or 'denied'");
        data.approved_by_user_ID = needUser(req);
      }
    }
  }
};

defs.statusLogs = {
  name: 'status-logs', table: 'Status_logs', pk: 'status_log_ID', path: '/status-logs', audit: false,
  allow: ['read', 'list'],
  fields: {
    incident_ID:            sys('int'),
    status_log_from_status: sys('enum', { values: INCIDENT_STATUSES }),
    status_log_to_status:   sys('enum', { values: INCIDENT_STATUSES }),
    actor_user_ID:          sys('int'),
    status_log_note:        sys('string'),
    status_log_changed_at:  sys('datetime')
  },
  filterable: ['incident_ID', 'actor_user_ID', 'status_log_to_status', 'status_log_changed_at'],
  defaultSort: ['status_log_changed_at', 'status_log_ID']
};

defs.incidentNotes = {
  name: 'incident-notes', table: 'Incident_notes', pk: 'incident_note_ID', path: '/incident-notes',
  allow: ['create', 'read', 'list'],
  fields: {
    incident_ID:              ref(),
    author_user_ID:           sys('int'),
    incident_note_body:       str(1000, { required: true, immutable: true }),
    incident_note_visibility: en(['internal', 'reporter'], { default: 'internal', immutable: true }),
    incident_note_created_at: sys('datetime')
  },
  filterable: ['incident_ID', 'author_user_ID', 'incident_note_visibility'],
  defaultSort: ['incident_note_created_at'],
  hooks: { async beforeCreate(data, { req }) { data.author_user_ID = needUser(req); data.incident_note_created_at = stamp(); } }
};

defs.incidentAttachments = {
  name: 'incident-attachments', table: 'Incident_attachments', pk: 'incident_attachment_ID', path: '/incident-attachments',
  allow: ['create', 'read', 'list'],
  fields: {
    incident_ID:                     ref(),
    incident_note_ID:                optRef(),
    uploaded_by_user_ID:             sys('int'),
    incident_attachment_file_url:    str(255, { required: true, immutable: true }),
    incident_attachment_mime_type:   str(50, { required: true, immutable: true }),
    incident_attachment_uploaded_at: sys('datetime')
  },
  filterable: ['incident_ID', 'incident_note_ID', 'uploaded_by_user_ID', 'incident_attachment_mime_type'],
  defaultSort: ['incident_attachment_uploaded_at'],
  hooks: { async beforeCreate(data, { req }) { data.uploaded_by_user_ID = needUser(req); data.incident_attachment_uploaded_at = stamp(); } }
};

defs.escalations = {
  name: 'escalations', table: 'Escalations', pk: 'escalation_ID', path: '/escalations',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    incident_ID:              ref(),
    raised_by_user_ID:        sys('int'),
    escalation_source:        en(['responder', 'dispatcher', 'sla_timer'], { required: true, immutable: true }),
    escalation_reason:        str(255, { required: true, immutable: true }),
    escalation_raised_at:     sys('datetime'),
    decided_by_user_ID:       sys('int'),
    escalation_decision:      en(['extra_resources', 'reprioritised', 'no_action'], { nullable: true }),
    escalation_decision_note: str(255, { nullable: true }),
    escalation_decided_at:    sys('datetime')
  },
  filterable: ['incident_ID', 'raised_by_user_ID', 'escalation_source', 'escalation_decision', 'decided_by_user_ID'],
  customFilters: {
    undecided: (v) => v === 'true' ? { sql: 'escalation_decision IS NULL', params: [] }
                : v === 'false' ? { sql: 'escalation_decision IS NOT NULL', params: [] } : undefined
  },
  defaultSort: ['-escalation_raised_at'],
  hooks: {
    async beforeCreate(data, { req }) {
      data.raised_by_user_ID = data.escalation_source === 'sla_timer' ? null : needUser(req);
      data.escalation_raised_at = stamp();
    },
    async beforeUpdate(data, { req, existing }) {
      if (existing.escalation_decision) throw new HttpError(409, 'This escalation has already been decided');
      if (data.escalation_decision) { data.decided_by_user_ID = needUser(req); data.escalation_decided_at = stamp(); }
    }
  }
};

const WORK_ORDER_MOVES = { submitted: ['resources_confirmed'], approved: ['scheduled'], scheduled: ['completed'] };
defs.workOrders = {
  name: 'work-orders', table: 'Work_orders', pk: 'work_order_ID', path: '/work-orders',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    incident_ID:                      ref(),
    raised_by_user_ID:                sys('int'),
    work_order_type:                  en(['re_inspection', 'make_safe', 'equipment_replacement', 'other'], { required: true, immutable: true }),
    work_order_description:           str(500, { required: true }),
    work_order_cost_estimate:         dec({ required: true, min: 0, max: 99999999.99 }),
    work_order_needs_second_approval: sys('boolean'),
    work_order_status:                en(['submitted', 'resources_confirmed', 'approved', 'rejected', 'scheduled', 'completed']),
    resource_checked_by_user_ID:      sys('int'),
    work_order_resource_checked_at:   sys('datetime'),
    work_order_scheduled_for:         dt({ nullable: true }),
    scheduled_shift_ID:               link(),
    scheduled_responder_ID:           link(),
    scheduled_by_user_ID:             sys('int'),
    work_order_created_at:            sys('datetime')
  },
  filterable: ['incident_ID', 'raised_by_user_ID', 'work_order_type', 'work_order_status', 'work_order_needs_second_approval', 'scheduled_shift_ID', 'scheduled_responder_ID'],
  defaultSort: ['-work_order_created_at'],
  hooks: {
    async beforeCreate(data, { req, conn }) {
      forbidOnCreate(data, ['work_order_scheduled_for', 'scheduled_shift_ID', 'scheduled_responder_ID', 'work_order_status']);
      data.raised_by_user_ID = needUser(req);
      data.work_order_status = 'submitted';
      data.work_order_created_at = stamp();
      data.work_order_needs_second_approval = data.work_order_cost_estimate > await secondApprovalThreshold(conn);
    },

    async beforeUpdate(data, { req, conn, existing }) {
      if (data.work_order_cost_estimate !== undefined && data.work_order_cost_estimate !== existing.work_order_cost_estimate) {
        if (existing.work_order_status !== 'submitted') throw new HttpError(409, 'The cost can only change before the resource check');
        data.work_order_needs_second_approval = data.work_order_cost_estimate > await secondApprovalThreshold(conn);
      }
      const next = data.work_order_status;
      if (!next || next === existing.work_order_status) return;
      if (!(WORK_ORDER_MOVES[existing.work_order_status] || []).includes(next)) {
        throw new HttpError(409, `A work order cannot be moved from '${existing.work_order_status}' to '${next}' this way` +
          " (approval and rejection happen through /work-order-approvals)", { allowed: WORK_ORDER_MOVES[existing.work_order_status] || [] });
      }
      if (next === 'resources_confirmed') {
        data.resource_checked_by_user_ID = needUser(req);
        data.work_order_resource_checked_at = stamp();
      }
      if (next === 'scheduled') {
        const m = { ...existing, ...data };
        for (const f of ['work_order_scheduled_for', 'scheduled_shift_ID', 'scheduled_responder_ID']) if (m[f] == null) throw bad(f, 'is required when scheduling a work order');
        await assertOnShift(conn, m.scheduled_shift_ID, m.scheduled_responder_ID, m.work_order_scheduled_for, 'scheduled_responder_ID');
        data.scheduled_by_user_ID = needUser(req);
      }
    }
  }
};

defs.workOrderEquipment = {
  name: 'work-order-equipment', table: 'Work_order_equipment', pk: ['work_order_ID', 'equipment_type_ID'],
  fields: {
    work_order_ID:                 ref(),
    equipment_type_ID:             ref(),
    work_order_equipment_quantity: int({ required: true, min: 1, max: 1000 })
  },
  filterable: ['work_order_ID', 'equipment_type_ID'], defaultSort: ['work_order_ID', 'equipment_type_ID']
};

defs.workOrderSkills = {
  name: 'work-order-skills', table: 'Work_order_skills', pk: ['work_order_ID', 'skill_ID'],
  fields: {
    work_order_ID:             ref(),
    skill_ID:                  ref(),
    work_order_skill_quantity: int({ required: true, min: 1, max: 1000 })
  },
  filterable: ['work_order_ID', 'skill_ID'], defaultSort: ['work_order_ID', 'skill_ID']
};

defs.workOrderApprovals = {
  name: 'work-order-approvals', table: 'Work_order_approvals', pk: 'work_order_approval_ID', path: '/work-order-approvals',
  allow: ['create', 'read', 'list'],
  fields: {
    work_order_ID:                  ref(),
    approver_user_ID:               sys('int'),
    work_order_approval_level:      int({ required: true, immutable: true, min: 1, max: 2 }),
    work_order_approval_decision:   en(['approved', 'rejected'], { required: true, immutable: true }),
    work_order_approval_reason:     str(255, { nullable: true, immutable: true }),
    work_order_approval_decided_at: sys('datetime')
  },
  filterable: ['work_order_ID', 'approver_user_ID', 'work_order_approval_level', 'work_order_approval_decision'],
  defaultSort: ['work_order_ID', 'work_order_approval_level'],
  hooks: {
    async beforeCreate(data, ctx) {
      const { req, conn } = ctx;
      data.approver_user_ID = needUser(req);
      if (data.work_order_approval_decision === 'rejected' && !data.work_order_approval_reason) {
        throw bad('work_order_approval_reason', 'is required when rejecting, so the responder knows why');
      }
      const [wo] = await conn.query('SELECT work_order_status AS status, work_order_needs_second_approval AS needs2 FROM `Work_orders` WHERE work_order_ID = ? FOR UPDATE', [data.work_order_ID]);
      if (!wo.length) throw new HttpError(422, 'work_order_ID does not match a work order');
      if (wo[0].status !== 'resources_confirmed') throw new HttpError(409, `The work order is '${wo[0].status}'; it must be 'resources_confirmed' to be approved or rejected`);
      ctx.needsSecond = !!wo[0].needs2;

      if (data.work_order_approval_level === 2) {
        if (!ctx.needsSecond) throw new HttpError(409, 'This work order does not need a second approval');
        const [l1] = await conn.query('SELECT approver_user_ID AS approver, work_order_approval_decision AS d FROM `Work_order_approvals` WHERE work_order_ID = ? AND work_order_approval_level = 1', [data.work_order_ID]);
        if (!l1.length || l1[0].d !== 'approved') throw new HttpError(409, 'Level 1 must be approved before level 2');
        if (l1[0].approver === data.approver_user_ID) throw new HttpError(409, 'The level 2 approver must be a different user from the level 1 approver');
      }
      data.work_order_approval_decided_at = stamp();
    },
    async afterCreate(id, data, ctx) {
      const done = data.work_order_approval_decision === 'rejected' ? 'rejected'
        : (data.work_order_approval_level === 2 || !ctx.needsSecond) ? 'approved' : null;
      if (done) await ctx.conn.query('UPDATE `Work_orders` SET work_order_status = ? WHERE work_order_ID = ?', [done, data.work_order_ID]);
    }
  }
};

defs.notifications = {
  name: 'notifications', table: 'Notifications', pk: 'notification_ID', path: '/notifications', audit: false,
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    user_ID:                      ref(),
    notification_type:            str(40, { required: true, immutable: true }),
    notification_payload:         json({ required: true, immutable: true }),
    notification_requires_ack:    bool({ default: false, immutable: true }),
    notification_created_at:      sys('datetime'),
    notification_read_at:         sys('datetime'),
    notification_acknowledged_at: sys('datetime'),
    mark_read:                    bool({ virtual: true }),
    mark_acknowledged:            bool({ virtual: true })
  },
  filterable: ['user_ID', 'notification_type', 'notification_requires_ack'],
  customFilters: {
    unread: (v) => v === 'true' ? { sql: 'notification_read_at IS NULL', params: [] }
              : v === 'false' ? { sql: 'notification_read_at IS NOT NULL', params: [] } : undefined
  },
  defaultSort: ['-notification_created_at'],
  hooks: {
    async beforeCreate(data) { data.notification_created_at = stamp(); },
    async beforeUpdate(data, { existing }) {
      if (data.mark_read && !existing.notification_read_at) data.notification_read_at = stamp();
      if (data.mark_acknowledged) {
        if (!existing.notification_requires_ack) throw new HttpError(409, 'This notification does not need to be acknowledged');
        if (!existing.notification_acknowledged_at) {
          data.notification_acknowledged_at = stamp();
          if (!existing.notification_read_at) data.notification_read_at = data.notification_acknowledged_at;
        }
      }
    }
  }
};

defs.zonePriorityRules = {
  name: 'zone-priority-rules', table: 'Zone_priority_rules', pk: 'zone_priority_rule_ID', path: '/zone-priority-rules',
  fields: {
    zone_ID:                       ref(),
    incident_category_ID:          ref(),
    zone_priority_rule_weight:     dec({ required: true, min: 0, max: 99.99 }),
    set_by_user_ID:                sys('int'),
    zone_priority_rule_updated_at: sys('datetime')
  },
  filterable: ['zone_ID', 'incident_category_ID'],
  defaultSort: ['zone_ID', 'incident_category_ID'],
  hooks: {
    async beforeCreate(data, { req }) { data.set_by_user_ID = needUser(req); data.zone_priority_rule_updated_at = stamp(); },
    async beforeUpdate(data, { req }) { data.set_by_user_ID = needUser(req); data.zone_priority_rule_updated_at = stamp(); },

    async afterCreate(id, data, { conn }) { await rescore(conn, data.zone_ID, data.incident_category_ID, data.zone_priority_rule_weight); },
    async afterUpdate(data, { conn, existing }) {
      if (data.zone_priority_rule_weight !== undefined) await rescore(conn, existing.zone_ID, existing.incident_category_ID, data.zone_priority_rule_weight);
    }
  }
};
async function rescore(conn, zoneId, categoryId, weight) {
  await conn.query(
    "UPDATE `Incidents` SET incident_priority_score = CASE incident_severity WHEN 'low' THEN 1 WHEN 'medium' THEN 2 WHEN 'high' THEN 3 ELSE 4 END * ? " +
    "WHERE zone_ID = ? AND incident_category_ID = ? AND incident_status NOT IN ('resolved', 'closed')", [weight, zoneId, categoryId]);
}

defs.auditLogs = {
  name: 'audit-logs', table: 'Audit_logs', pk: 'audit_log_ID', path: '/audit-logs', audit: false,
  allow: ['read', 'list'],
  fields: {
    actor_user_ID:         sys('int'),
    audit_log_action:      sys('string'),
    audit_log_entity:      sys('string'),
    audit_log_entity_ID:   sys('int'),
    audit_log_before_json: sys('json'),
    audit_log_after_json:  sys('json'),
    audit_log_ip_address:  sys('string'),
    audit_log_ts:          sys('datetime'),
    audit_log_row_hash:    sys('string')
  },
  filterable: ['actor_user_ID', 'audit_log_action', 'audit_log_entity', 'audit_log_entity_ID', 'audit_log_ts'],
  defaultSort: ['-audit_log_ts']
};

defs.patternFlags = {
  name: 'pattern-flags', table: 'Pattern_flags', pk: 'pattern_flag_ID', path: '/pattern-flags',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    pattern_flag_rule_key:     str(50, { required: true, immutable: true }),
    zone_ID:                   optRef(),
    incident_category_ID:      optRef(),
    site_ID:                   optRef(),
    pattern_flag_description:  str(255, { required: true, immutable: true }),
    pattern_flag_window_start: dt({ required: true, immutable: true }),
    pattern_flag_window_end:   dt({ required: true, immutable: true }),
    pattern_flag_raised_at:    sys('datetime'),
    pattern_flag_status:       en(['raised', 'confirmed', 'dismissed']),
    reviewed_by_user_ID:       sys('int'),
    pattern_flag_reviewed_at:  sys('datetime')
  },
  filterable: ['pattern_flag_rule_key', 'zone_ID', 'incident_category_ID', 'site_ID', 'pattern_flag_status'],
  defaultSort: ['-pattern_flag_raised_at'],
  hooks: {
    async beforeCreate(data) {
      assertOrder(data.pattern_flag_window_start, data.pattern_flag_window_end, 'pattern_flag_window_end', 'must be after pattern_flag_window_start');
      data.pattern_flag_raised_at = stamp();
      data.pattern_flag_status = 'raised';
    },
    async beforeUpdate(data, { req, existing }) {
      if (existing.pattern_flag_status !== 'raised') throw new HttpError(409, `This flag was already ${existing.pattern_flag_status}`);
      if (!['confirmed', 'dismissed'].includes(data.pattern_flag_status)) throw bad('pattern_flag_status', "must be 'confirmed' or 'dismissed'");
      data.reviewed_by_user_ID = needUser(req);
      data.pattern_flag_reviewed_at = stamp();
    }
  }
};

defs.savedReports = {
  name: 'saved-reports', table: 'Saved_reports', pk: 'saved_report_ID', path: '/saved-reports',
  fields: {
    analyst_user_ID:         sys('int'),
    saved_report_name:       str(100, { required: true }),
    saved_report_type:       str(40, { required: true }),
    saved_report_chart_type: str(20, { nullable: true }),
    saved_report_filter_json: json({ required: true }),
    saved_report_created_at: sys('datetime'),
    saved_report_last_run_at: sys('datetime'),
    mark_run:                bool({ virtual: true })
  },
  filterable: ['analyst_user_ID', 'saved_report_type'],
  searchable: ['saved_report_name'],
  defaultSort: ['saved_report_name'],
  hooks: {
    async beforeCreate(data, { req }) { data.analyst_user_ID = needUser(req); data.saved_report_created_at = stamp(); },
    async beforeUpdate(data) { if (data.mark_run) data.saved_report_last_run_at = stamp(); }
  }
};

defs.systemSettings = {
  name: 'system-settings', table: 'System_settings', pk: 'system_setting_key', autoKey: false, path: '/system-settings',
  allow: ['create', 'read', 'update', 'list'],
  fields: {
    system_setting_key:         str(60, { required: true, immutable: true }),
    system_setting_value:       str(255, { required: true }),
    system_setting_description: str(255, { required: true }),
    updated_by_user_ID:         sys('int'),
    system_setting_updated_at:  sys('datetime')
  },
  filterable: ['system_setting_key'],
  searchable: ['system_setting_key', 'system_setting_description'],
  defaultSort: ['system_setting_key'],
  hooks: {
    async beforeCreate(data, { req }) { data.updated_by_user_ID = needUser(req); data.system_setting_updated_at = stamp(); },
    async beforeUpdate(data, { req }) { data.updated_by_user_ID = needUser(req); data.system_setting_updated_at = stamp(); }
  }
};

defs.simulationRuns = {
  name: 'simulation-runs', table: 'Simulation_runs', pk: 'simulation_run_ID', path: '/simulation-runs', audit: false,
  allow: ['create', 'read', 'list'],
  fields: {
    simulation_run_batch_label:         str(60, { required: true, immutable: true }),
    simulation_run_strategy:            en(['greedy', 'batched_hungarian', 'auction'], { required: true, immutable: true }),
    simulation_run_seed:                int({ required: true, immutable: true }),
    simulation_run_scenario_json:       json({ required: true, immutable: true }),
    simulation_run_incidents_simulated: int({ required: true, immutable: true, min: 0 }),
    simulation_run_avg_response_secs:   dec({ required: true, immutable: true, min: 0, max: 999999.99 }),
    simulation_run_p95_response_secs:   dec({ required: true, immutable: true, min: 0, max: 999999.99 }),
    simulation_run_sla_breach_rate:     dec({ required: true, immutable: true, min: 0, max: 1 }),
    simulation_run_avg_travel_km:       dec({ required: true, immutable: true, min: 0, max: 99999.99 }),
    simulation_run_workload_stddev:     dec({ required: true, immutable: true, min: 0, max: 99.9999 }),
    simulation_run_avg_match_ms:        dec({ required: true, immutable: true, min: 0, max: 999999.99 }),
    run_by_user_ID:                     sys('int'),
    simulation_run_started_at:          dt({ default: stamp, immutable: true }),
    simulation_run_finished_at:         dt({ nullable: true, immutable: true })
  },
  filterable: ['simulation_run_batch_label', 'simulation_run_strategy', 'simulation_run_seed', 'run_by_user_ID'],
  defaultSort: ['-simulation_run_started_at'],
  hooks: { async beforeCreate(data, { req }) { data.run_by_user_ID = needUser(req); } }
};

const deactivateUser = (crud) => asyncHandler(async (req, res) => {
  const adminId = needUser(req);
  const id = crud.keyValues(req).user_ID;
  const user = await crud.findById(id);
  if (!user) throw new HttpError(404, 'users record not found');
  if (user.user_status === 'deactivated') throw new HttpError(409, 'This user is already deactivated');
  await pool.query("UPDATE `Users` SET user_status = 'deactivated', user_deactivated_at = ?, deactivated_by_user_ID = ? WHERE user_ID = ?", [sqlNow(), adminId, id]);
  res.json({ data: await crud.findById(id) });
});

function readStatusBody(body, allowedStatuses, noteRequiredFor, noteField) {
  const { to_status: toStatus, note } = body || {};
  const errors = [];
  if (!allowedStatuses.includes(toStatus)) errors.push({ field: 'to_status', message: `must be one of: ${allowedStatuses.join(', ')}` });
  if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 255)) errors.push({ field: noteField, message: 'must be text of at most 255 characters' });
  if (noteRequiredFor.includes(toStatus) && !(typeof note === 'string' && note.trim())) errors.push({ field: noteField, message: `is required when moving to '${toStatus}'` });
  if (errors.length) throw new HttpError(400, 'Validation failed', errors);
  return { toStatus, note: typeof note === 'string' && note.trim() ? note.trim() : null };
}

const INCIDENT_MOVES = {
  reported:  ['triaged', 'escalated'],
  triaged:   ['matched', 'escalated'],
  matched:   ['accepted', 'triaged', 'escalated'],
  accepted:  ['en_route', 'escalated'],
  en_route:  ['on_scene', 'escalated'],
  on_scene:  ['resolved', 'escalated'],
  resolved:  ['closed', 'reopened'],
  closed:    ['reopened'],
  escalated: ['triaged', 'matched'],
  reopened:  ['triaged', 'matched', 'escalated']
};
const changeIncidentStatus = (crud) => asyncHandler(async (req, res) => {
  const actor = needUser(req);
  const id = crud.keyValues(req).incident_ID;
  const { toStatus, note } = readStatusBody(req.body, INCIDENT_STATUSES, ['resolved', 'reopened', 'escalated'], 'note');

  const updated = await crud.inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT incident_status FROM `Incidents` WHERE incident_ID = ? FOR UPDATE', [id]);
    if (!rows.length) throw new HttpError(404, 'incidents record not found');
    const from = rows[0].incident_status;
    if (!INCIDENT_MOVES[from].includes(toStatus)) throw new HttpError(409, `An incident cannot move from '${from}' to '${toStatus}'`, { allowed: INCIDENT_MOVES[from] });

    const now = sqlNow();
    const sets = ['incident_status = ?'];
    const params = [toStatus];
    if (toStatus === 'closed') { sets.push('incident_closed_at = ?'); params.push(now); }
    if (toStatus === 'reopened') sets.push('incident_closed_at = NULL', 'incident_reopened_count = incident_reopened_count + 1');
    await conn.query(`UPDATE \`Incidents\` SET ${sets.join(', ')} WHERE incident_ID = ?`, [...params, id]);
    await conn.query(
      'INSERT INTO `Status_logs` (incident_ID, status_log_from_status, status_log_to_status, actor_user_ID, status_log_note, status_log_changed_at) VALUES (?, ?, ?, ?, ?, ?)',
      [id, from, toStatus, actor, note, now]);
    return crud.findById(id, conn);
  });
  res.json({ data: updated });
});

const ASSIGNMENT_MOVES = {
  offered:  ['accepted', 'declined', 'timed_out', 'cancelled', 'reassigned'],
  accepted: ['en_route', 'cancelled', 'reassigned'],
  en_route: ['on_scene', 'cancelled', 'reassigned'],
  on_scene: ['resolved', 'cancelled', 'reassigned']
};
const ASSIGNMENT_STAMP = { accepted: 'assignment_responded_at', declined: 'assignment_responded_at', en_route: 'assignment_en_route_at',
                           on_scene: 'assignment_on_scene_at', resolved: 'assignment_resolved_at' };
const changeAssignmentStatus = (crud) => asyncHandler(async (req, res) => {
  needUser(req);
  const id = crud.keyValues(req).assignment_ID;
  const { to_status: toStatus, decline_reason: reason } = req.body || {};
  const errors = [];
  if (!ASSIGNMENT_STATUSES.includes(toStatus) || toStatus === 'offered') errors.push({ field: 'to_status', message: `must be one of: ${ASSIGNMENT_STATUSES.slice(1).join(', ')}` });
  if (toStatus === 'declined' && !(typeof reason === 'string' && reason.trim())) errors.push({ field: 'decline_reason', message: "is required when moving to 'declined'" });
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > 255)) errors.push({ field: 'decline_reason', message: 'must be text of at most 255 characters' });
  if (errors.length) throw new HttpError(400, 'Validation failed', errors);

  const updated = await crud.inTransaction(async (conn) => {
    const [rows] = await conn.query('SELECT assignment_status AS status, assignment_approval_status AS approval, responder_ID FROM `Assignments` WHERE assignment_ID = ? FOR UPDATE', [id]);
    if (!rows.length) throw new HttpError(404, 'assignments record not found');
    const { status: from, approval, responder_ID: responderId } = rows[0];
    if (!(ASSIGNMENT_MOVES[from] || []).includes(toStatus)) throw new HttpError(409, `An assignment cannot move from '${from}' to '${toStatus}'`, { allowed: ASSIGNMENT_MOVES[from] || [] });
    if (toStatus === 'accepted' && approval === 'pending') throw new HttpError(409, 'This off-shift or out-of-zone assignment needs Shift Supervisor approval first');
    if (toStatus === 'accepted' && approval === 'denied') throw new HttpError(409, 'The Shift Supervisor denied this assignment');

    const sets = ['assignment_status = ?'];
    const params = [toStatus];
    if (ASSIGNMENT_STAMP[toStatus]) { sets.push(`${ASSIGNMENT_STAMP[toStatus]} = ?`); params.push(sqlNow()); }
    if (toStatus === 'declined') { sets.push('assignment_decline_reason = ?'); params.push(reason.trim()); }
    await conn.query(`UPDATE \`Assignments\` SET ${sets.join(', ')} WHERE assignment_ID = ?`, [...params, id]);

    if (toStatus === 'accepted') {
      await conn.query("UPDATE `Responders` SET responder_availability = 'on_task' WHERE responder_ID = ? AND responder_availability = 'available'", [responderId]);
    } else if (!['en_route', 'on_scene'].includes(toStatus)) {
      const [[{ active }]] = await conn.query("SELECT COUNT(*) AS active FROM `Assignments` WHERE responder_ID = ? AND assignment_status IN ('accepted', 'en_route', 'on_scene')", [responderId]);
      if (active === 0) await conn.query("UPDATE `Responders` SET responder_availability = 'available' WHERE responder_ID = ? AND responder_availability = 'on_task'", [responderId]);
    }
    return crud.findById(id, conn);
  });
  res.json({ data: updated });
});

const nearestResponders = asyncHandler(async (req, res) => {
  const lat = Number(req.query.lat), lon = Number(req.query.lon);
  const radius = req.query.radius_km === undefined ? 10 : Number(req.query.radius_km);
  const limit = req.query.limit === undefined ? 5 : Number(req.query.limit);
  const errors = [];
  if (req.query.lat === undefined || !Number.isFinite(lat) || Math.abs(lat) > 90) errors.push({ field: 'lat', message: 'is required and must be between -90 and 90' });
  if (req.query.lon === undefined || !Number.isFinite(lon) || Math.abs(lon) > 180) errors.push({ field: 'lon', message: 'is required and must be between -180 and 180' });
  if (!Number.isFinite(radius) || radius <= 0 || radius > 500) errors.push({ field: 'radius_km', message: 'must be between 0 and 500' });
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) errors.push({ field: 'limit', message: 'must be between 1 and 50' });
  if (errors.length) throw new HttpError(400, 'Validation failed', errors);

  const dLat = radius / 111.32;
  const dLon = radius / (111.32 * Math.max(Math.cos(lat * Math.PI / 180), 0.01));
  const [rows] = await pool.query(
    'SELECT responder_ID, responder_callsign, station_site_ID, responder_latitude, responder_longitude, responder_last_ping_at, ' +
    '(6371 * 2 * ASIN(SQRT(POW(SIN(RADIANS(responder_latitude - ?) / 2), 2) + COS(RADIANS(?)) * COS(RADIANS(responder_latitude)) * ' +
    'POW(SIN(RADIANS(responder_longitude - ?) / 2), 2)))) AS distance_km ' +
    "FROM `Responders` WHERE responder_availability = 'available' AND responder_latitude BETWEEN ? AND ? AND responder_longitude BETWEEN ? AND ? " +
    'HAVING distance_km <= ? ORDER BY distance_km LIMIT ?',
    [lat, lat, lon, lat - dLat, lat + dLat, lon - dLon, lon + dLon, radius, limit]);
  res.json({ data: rows.map((r) => ({ ...r, responder_latitude: Number(r.responder_latitude), responder_longitude: Number(r.responder_longitude),
                                      responder_last_ping_at: r.responder_last_ping_at ? new Date(String(r.responder_last_ping_at).replace(' ', 'T') + 'Z').toISOString() : null,
                                      distance_km: Math.round(Number(r.distance_km) * 100) / 100 })) });
});

const controllers = {};
for (const [key, def] of Object.entries(defs)) controllers[key] = createCrud(def);

controllers.users.deactivate = deactivateUser(controllers.users);
controllers.incidents.changeStatus = changeIncidentStatus(controllers.incidents);
controllers.assignments.changeStatus = changeAssignmentStatus(controllers.assignments);
controllers.responders.nearest = nearestResponders;

Object.defineProperty(controllers, '_definitions', { value: defs, enumerable: false });
module.exports = controllers;
