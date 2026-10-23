const pad = (n) => String(n).padStart(2, '0');

function toMysqlDateTime(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
         `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function toDbValue(type, value) {
  if (value === undefined || value === null) return null;
  switch (type) {
    case 'boolean': return value ? 1 : 0;
    case 'datetime': return toMysqlDateTime(new Date(value));
    case 'json': return JSON.stringify(value);
    default: return value;
  }
}

function fromDbValue(type, value) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'boolean': return Boolean(Number(value));
    case 'int':
    case 'decimal': return Number(value);
    case 'datetime': return new Date(String(value).replace(' ', 'T') + 'Z').toISOString();
    case 'date': return String(value).slice(0, 10);
    case 'json':
      if (typeof value !== 'string') return value;
      try { return JSON.parse(value); } catch { return value; }
    default: return value;
  }
}

function rowFromDb(row, fields, keys = []) {
  const out = {};
  for (const [name, value] of Object.entries(row)) {
    const def = fields[name];
    const type = def ? def.type : (keys.includes(name) ? 'int' : undefined);
    out[name] = type ? fromDbValue(type, value) : value;
  }
  return out;
}

module.exports = { toMysqlDateTime, toDbValue, fromDbValue, rowFromDb };
