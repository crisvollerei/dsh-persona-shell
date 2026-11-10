const MIN_INSTANT = -62135596800000;
const MAX_INSTANT = 253402300799999;
const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

// Read JSON-like metadata without invoking a getter, coercion or inherited field.
function ownData(value, key) {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property && Object.hasOwn(property, 'value') ? property.value : undefined;
  } catch { return; }
}

const validInstant = value => Number.isSafeInteger(value) && value >= MIN_INSTANT && value <= MAX_INSTANT;
const validOffset = value => Number.isInteger(value) && value >= -840 && value <= 840;
const validZone = value => typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9_+./-]+$/u.test(value);

function utcFields(instant) {
  const date = new Date(instant), year = date.getUTCFullYear();
  if (year < 1 || year > 9999 || !Number.isFinite(year)) return null;
  const iso = date.toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16), weekday: WEEKDAYS[date.getUTCDay()] };
}

function zonedFields(instant, zone) {
  if (!validZone(zone)) return null;
  try {
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: zone, calendar: 'gregory', numberingSystem: 'latn',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    const timeZone = formatter.resolvedOptions().timeZone;
    if (!validZone(timeZone)) return null;
    const parts = Object.fromEntries(formatter.formatToParts(new Date(instant)).map(part => [part.type, part.value]));
    if (!['year', 'month', 'day', 'hour', 'minute', 'second'].every(key => typeof parts[key] === 'string' && /^\d{1,4}$/u.test(parts[key]))) return null;
    const [year, month, day, hour, minute, second] = ['year', 'month', 'day', 'hour', 'minute', 'second'].map(key => Number(parts[key]));
    if (year < 1 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
    const local = new Date(0); local.setUTCFullYear(year, month - 1, day); local.setUTCHours(hour, minute, second, 0);
    const fields = utcFields(local.getTime());
    if (!fields || local.getUTCFullYear() !== year || local.getUTCMonth() !== month - 1 || local.getUTCDate() !== day) return null;
    // Current civil offsets are whole minutes. Round historical subminute offsets
    // only for the offset label; the local calendar/time above comes from IANA.
    const utcOffsetMinutes = Math.round((local.getTime() - Math.floor(instant / 1000) * 1000) / 60000);
    if (!validOffset(utcOffsetMinutes)) return null;
    return { ...fields, timeZone, utcOffsetMinutes, source: 'client-time-zone' };
  } catch { return null; }
}

/** Capture once when a user starts a chat round; this value is never chat history. */
export function createChatTimeContext(clientTime, now = Date.now()) {
  const fallbackNow = validInstant(now) ? now : Date.now();
  const instant = validInstant(fallbackNow) ? fallbackNow : 0;
  const capturedAt = new Date(instant).toISOString();
  const zoned = zonedFields(instant, ownData(clientTime, 'timeZone'));
  if (zoned) return { capturedAt, ...zoned };
  const offset = ownData(clientTime, 'utcOffsetMinutes');
  if (validOffset(offset)) {
    const shifted = utcFields(instant + offset * 60000);
    if (shifted) return { capturedAt, ...shifted, timeZone: null, utcOffsetMinutes: offset === 0 ? 0 : offset, source: 'client-utc-offset' };
  }
  return { capturedAt, ...utcFields(instant), timeZone: 'UTC', utcOffsetMinutes: 0, source: 'utc-fallback' };
}

/** Recompute the prompt envelope; do not trust caller-supplied date/time prose. */
export function normalizeChatTimeContext(value) {
  const capturedAt = ownData(value, 'capturedAt'), source = ownData(value, 'source');
  if (typeof capturedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(capturedAt)) return null;
  const instant = Date.parse(capturedAt);
  if (!validInstant(instant) || new Date(instant).toISOString() !== capturedAt) return null;
  if (source === 'utc-fallback') return createChatTimeContext(null, instant);
  if (source === 'client-utc-offset') return createChatTimeContext({ utcOffsetMinutes: ownData(value, 'utcOffsetMinutes') }, instant);
  if (source === 'client-time-zone') return createChatTimeContext({ timeZone: ownData(value, 'timeZone'), utcOffsetMinutes: ownData(value, 'utcOffsetMinutes') }, instant);
  return null;
}
