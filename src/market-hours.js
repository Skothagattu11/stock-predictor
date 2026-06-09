'use strict';

// US equities regular session: Mon-Fri, 09:30-16:00 America/New_York.
// We compute the NY wall-clock time via Intl so the result is independent of
// the server's local timezone. (Does not account for market holidays.)

const NY_TZ = 'America/New_York';

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: NY_TZ,
  weekday: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

// Returns { weekday:'Mon'.., minutes: minutesSinceMidnight } in NY time.
function nyParts(date) {
  const parts = fmt.formatToParts(date);
  let weekday = '';
  let hour = 0;
  let minute = 0;
  for (const p of parts) {
    if (p.type === 'weekday') weekday = p.value;
    else if (p.type === 'hour') hour = parseInt(p.value, 10);
    else if (p.type === 'minute') minute = parseInt(p.value, 10);
  }
  // Intl with hour12:false can yield '24' at midnight in some engines.
  if (hour === 24) hour = 0;
  return { weekday, minutes: hour * 60 + minute };
}

const OPEN_MIN = 9 * 60 + 30; // 09:30
const CLOSE_MIN = 16 * 60; // 16:00
const WEEKDAYS = new Set(['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

function isMarketOpen(date = new Date()) {
  const { weekday, minutes } = nyParts(date);
  if (!WEEKDAYS.has(weekday)) return false;
  return minutes >= OPEN_MIN && minutes < CLOSE_MIN;
}

function marketStatus(date = new Date()) {
  return isMarketOpen(date) ? 'open' : 'closed';
}

module.exports = { isMarketOpen, marketStatus };
