const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;
const POLYGON = /^\s*POLYGON\s*\(\(.+\)\)\s*$/i;

const isValidDate = (s) => DATE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

function checkValue(def, value) {
  switch (def.type) {
    case 'string':
    case 'email': {
      if (typeof value !== 'string') return { error: 'must be text' };
      const v = def.type === 'email' ? value.trim().toLowerCase() : value.trim();
      if (def.type === 'email' && !EMAIL.test(v)) return { error: 'must be a valid email address' };
      if (def.min !== undefined && v.length < def.min) return { error: `must be at least ${def.min} characters` };
      if (def.max !== undefined && v.length > def.max) return { error: `must be at most ${def.max} characters` };
      if (def.required && v === '') return { error: 'cannot be empty' };
      return { value: v };
    }
    case 'int':
    case 'decimal': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return { error: 'must be a number' };
      if (def.type === 'int' && !Number.isInteger(value)) return { error: 'must be a whole number' };
      if (def.min !== undefined && value < def.min) return { error: `must be at least ${def.min}` };
      if (def.max !== undefined && value > def.max) return { error: `must be at most ${def.max}` };
      return { value };
    }
    case 'boolean':
      if (typeof value !== 'boolean') return { error: 'must be true or false' };
      return { value };
    case 'enum':
      if (!def.values.includes(value)) return { error: `must be one of: ${def.values.join(', ')}` };
      return { value };
    case 'datetime':
      if (typeof value !== 'string' || !DATETIME.test(value) || Number.isNaN(Date.parse(value))) {
        return { error: 'must be an ISO 8601 date-time, for example 2026-10-23T14:30:00Z' };
      }
      return { value: new Date(value).toISOString() };
    case 'date':
      if (typeof value !== 'string' || !isValidDate(value)) return { error: 'must be a date in the form YYYY-MM-DD' };
      return { value };
    case 'json':
      if (value === null || typeof value !== 'object') return { error: 'must be a JSON object or array' };
      return { value };
    case 'polygon':
      if (typeof value !== 'string' || !POLYGON.test(value)) return { error: 'must be WKT text, for example POLYGON((lon lat, lon lat, ...))' };
      return { value: value.trim() };
    default:
      return { value };
  }
}

function validateBody(body, resource, mode) {
  const errors = [];
  const data = {};
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { errors: [{ field: 'body', message: 'must be a JSON object' }], data };
  }
  const { fields } = resource;
  const creating = mode === 'create';

  for (const [name, value] of Object.entries(body)) {
    const def = fields[name];
    if (!def || def.hidden) { errors.push({ field: name, message: 'is not a known field' }); continue; }
    if (def.readOnly) { errors.push({ field: name, message: 'is set by the system and cannot be supplied' }); continue; }
    if (!creating && (def.immutable || def.createOnly)) { errors.push({ field: name, message: 'cannot be changed after the record is created' }); continue; }
    if (value === undefined) continue;
    if (value === null) {
      if (def.nullable) data[name] = null;
      else errors.push({ field: name, message: 'cannot be null' });
      continue;
    }
    const result = checkValue(def, value);
    if (result.error) errors.push({ field: name, message: result.error });
    else data[name] = result.value;
  }

  for (const [name, def] of Object.entries(fields)) {
    if (def.readOnly || def.hidden || body[name] !== undefined) continue;
    if (creating) {
      if (def.default !== undefined) data[name] = typeof def.default === 'function' ? def.default() : def.default;
      else if (def.required) errors.push({ field: name, message: 'is required' });
    } else if (mode === 'replace' && def.required && !def.immutable && !def.createOnly && !def.virtual) {
      errors.push({ field: name, message: 'is required' });
    }
  }

  return { errors, data };
}

function coerceQueryValue(def, raw) {
  const s = String(raw).trim();
  switch (def.type) {
    case 'int': {
      if (!/^-?\d+$/.test(s)) return undefined;
      return Number(s);
    }
    case 'decimal': {
      const n = Number(s);
      return s !== '' && Number.isFinite(n) ? n : undefined;
    }
    case 'boolean':
      if (s === 'true' || s === '1') return true;
      if (s === 'false' || s === '0') return false;
      return undefined;
    case 'enum':
      return def.values.includes(s) ? s : undefined;
    case 'datetime':
      if (isValidDate(s)) return new Date(s + 'T00:00:00Z').toISOString();
      return DATETIME.test(s) && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : undefined;
    case 'date':
      return isValidDate(s) ? s : undefined;
    case 'json':
    case 'polygon':
      return undefined;
    default:
      return s;
  }
}

module.exports = { validateBody, coerceQueryValue };
