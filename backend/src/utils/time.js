// Local-time helpers. Every calendar date / weekday / clock comparison goes through here.
const TZ = process.env.SYSTEM_TIMEZONE || 'Asia/Manila';
// shortcut: fixed UTC offset (Asia/Manila has no DST); upgrade if SYSTEM_TIMEZONE ever points at a DST zone.
const TZ_OFFSET = '+08:00';

const partsFmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  weekday: 'long', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// { date: 'YYYY-MM-DD', dayName: 'Monday', minutes: minutes since local midnight }
function localNow(at = new Date()) {
  const p = Object.fromEntries(partsFmt.formatToParts(at).map(x => [x.type, x.value]));
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    dayName: p.weekday,
    minutes: Number(p.hour) * 60 + Number(p.minute),
  };
}

// 'YYYY-MM-DD' in local time
function localDateStr(at = new Date()) {
  return localNow(at).date;
}

// ISO (UTC) instant for a local date + 'HH:MM:SS'
function localIso(dateStr, time = '00:00:00') {
  return new Date(`${dateStr}T${time}${TZ_OFFSET}`).toISOString();
}

// UTC ISO bounds of a local calendar day, for .gte()/.lte() filters
function localDayRange(dateStr) {
  return { start: localIso(dateStr, '00:00:00'), end: localIso(dateStr, '23:59:59') };
}

module.exports = { TZ, localNow, localDateStr, localIso, localDayRange };
