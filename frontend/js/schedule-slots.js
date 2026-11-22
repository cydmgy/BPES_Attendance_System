// Free-window helper for the schedule picker (window.ScheduleSlots); also exports itself for node tests.
(function (root) {
  const mins = t => { const [h, m] = String(t).split(':'); return Number(h) * 60 + Number(m); };
  const hhmm = n => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;

  // '14:00' or '14:00:00' -> '2:00 PM'
  function to12h(t) {
    const [h, m] = String(t).split(':');
    return `${Number(h) % 12 || 12}:${m} ${Number(h) % 24 < 12 ? 'AM' : 'PM'}`;
  }

  // Gaps between busy {start,end} ranges inside the school day, as 'HH:MM' windows.
  function freeWindows(busy, dayStart = '07:00', dayEnd = '16:00') {
    const lo = mins(dayStart), hi = mins(dayEnd);
    const ranges = busy
      .map(b => [Math.max(mins(b.start), lo), Math.min(mins(b.end), hi)])
      .filter(([s, e]) => s < e)
      .sort((a, b) => a[0] - b[0]);
    const out = [];
    let cursor = lo;
    for (const [s, e] of ranges) {
      if (s > cursor) out.push({ start: hhmm(cursor), end: hhmm(s) });
      cursor = Math.max(cursor, e);
    }
    if (cursor < hi) out.push({ start: hhmm(cursor), end: hhmm(hi) });
    return out;
  }

  const api = { freeWindows, to12h };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScheduleSlots = api;
})(typeof window !== 'undefined' ? window : globalThis);
