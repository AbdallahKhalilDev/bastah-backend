// "When did today start, in Gaza?"
//
// The database stores every date in UTC (London time without summer time). But
// a seller's "today" starts at midnight in GAZA, which is 2 hours ahead of UTC
// in winter and 3 hours ahead in summer. So an order placed at 23:30 UTC is
// already 01:30 the NEXT day in Gaza, and must count as "today" there.
//
// Node has the world's time-zone rules built in (the Intl API), including
// Gaza's clock changes, so we never hard-code "+2" or "+3": the rules change
// from year to year, and Node's data keeps up with them.
const GAZA_TZ = "Asia/Gaza";

// One formatter, reused: it writes an instant out as Gaza's wall-clock time
// (year, month, day, hour, minute, second), using the 24-hour clock.
const gazaClock = new Intl.DateTimeFormat("en-US", {
  timeZone: GAZA_TZ,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

// The Gaza wall-clock reading of an instant, as numbers.
function gazaWallClock(instant) {
  const parts = {};
  for (const { type, value } of gazaClock.formatToParts(instant)) {
    parts[type] = Number(value);
  }
  return parts; // { year, month, day, hour, minute, second }
}

// How far Gaza's clock is ahead of UTC at this instant, in milliseconds
// (2 hours in winter, 3 in summer).
function gazaOffsetMs(instant) {
  const p = gazaWallClock(instant);
  const wallAsIfUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  // The wall clock has no milliseconds, so drop them from the instant too.
  const wholeSeconds = Math.floor(instant.getTime() / 1000) * 1000;
  return wallAsIfUtc - wholeSeconds;
}

// The instant Gaza's calendar day started, `daysAgo` days before today.
//   startOfGazaDay(0) → midnight at the start of today, in Gaza
//   startOfGazaDay(6) → midnight 6 days ago (so "today + the 6 days before"
//                       is the last 7 days)
// `now` can be passed in, so tests can use a fixed moment.
function startOfGazaDay(daysAgo = 0, now = new Date()) {
  // 1. Today's date ON THE GAZA CALENDAR (it may differ from the UTC date).
  const { year, month, day } = gazaWallClock(now);

  // 2. Midnight of the wanted day, written as if Gaza were UTC. Date.UTC copes
  //    with day 0 or day -3: it rolls back into the previous month by itself.
  const midnightAsIfUtc = Date.UTC(year, month - 1, day - daysAgo);

  // 3. Shift by Gaza's offset to get the real instant: Gaza midnight is 22:00
  //    UTC the evening before in winter (21:00 in summer).
  let instant = midnightAsIfUtc - gazaOffsetMs(new Date(midnightAsIfUtc));

  // 4. Step 3 measured the offset at a moment a few hours off. If summer time
  //    started or ended in between, that offset is an hour wrong; measuring
  //    once more, at the moment we found, corrects it.
  instant = midnightAsIfUtc - gazaOffsetMs(new Date(instant));

  return new Date(instant);
}

module.exports = { GAZA_TZ, startOfGazaDay };
