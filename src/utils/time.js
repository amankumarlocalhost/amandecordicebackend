'use strict';

function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Offset (ms) of `tz` from UTC at the given instant. */
function tzOffsetMs(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Converts a wall-clock time in `tz` to a UTC Date. Strings that already carry an offset or `Z`
 * are taken as absolute instants.
 */
function zonedToUtc(input, tz = 'Asia/Kolkata') {
  if (input instanceof Date) return input;
  const s = String(input);
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) return new Date(s);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (!m) return new Date(NaN);
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  let guess = naive - tzOffsetMs(new Date(naive), tz);
  guess = naive - tzOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

module.exports = { isValidTimeZone, zonedToUtc, tzOffsetMs };
