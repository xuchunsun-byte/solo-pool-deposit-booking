import { parseHours } from "./db.js";

const DAY_KEYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

export function zonedParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
  const map = {};
  for (const part of fmt.formatToParts(date)) {
    if (part.type !== "literal") map[part.type] = part.value;
  }
  return map;
}

function tzOffsetMs(date, timeZone) {
  const p = zonedParts(date, timeZone);
  const asUtc = Date.UTC(
    Number(p.year),
    Number(p.month) - 1,
    Number(p.day),
    Number(p.hour),
    Number(p.minute)
  );
  return asUtc - date.getTime();
}

export function localDateTimeToUtc(timeZone, year, month, day, hour, minute) {
  const guess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset1 = tzOffsetMs(guess, timeZone);
  const first = new Date(guess.getTime() - offset1);
  const offset2 = tzOffsetMs(first, timeZone);
  return new Date(guess.getTime() - offset2);
}

export function formatInZone(iso, timeZone, opts = {}) {
  const date = iso instanceof Date ? iso : new Date(iso);
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: opts.weekday ?? "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...opts,
  }).format(date);
}

export function openSlots(tech, { days = 14, now = new Date(), booked = [] } = {}) {
  const timeZone = tech.timezone || "America/New_York";
  const hours = parseHours(tech.weekly_hours);
  const duration = Number(tech.duration_minutes) || 120;
  const slots = [];
  const startDay = zonedParts(now, timeZone);
  let y = Number(startDay.year);
  let m = Number(startDay.month);
  let d = Number(startDay.day);

  for (let i = 0; i < days; i++) {
    const noon = localDateTimeToUtc(timeZone, y, m, d, 12, 0);
    const weekdayIndex = weekdayIndexInZone(noon, timeZone);
    const dayKey = DAY_KEYS[weekdayIndex];
    const conf = hours[dayKey];
    if (conf && conf.enabled !== false && conf.start && conf.end) {
      const [sh, sm] = conf.start.split(":").map(Number);
      const [eh, em] = conf.end.split(":").map(Number);
      let cursor = localDateTimeToUtc(timeZone, y, m, d, sh, sm);
      const end = localDateTimeToUtc(timeZone, y, m, d, eh, em);
      while (cursor.getTime() + duration * 60 * 1000 <= end.getTime()) {
        const slotEnd = new Date(cursor.getTime() + duration * 60 * 1000);
        if (cursor.getTime() > now.getTime() + 5 * 60 * 1000) {
          const startIso = cursor.toISOString();
          const endIso = slotEnd.toISOString();
          const taken = booked.some(
            (b) => b.start_at < endIso && b.end_at > startIso && b.status !== "canceled"
          );
          if (!taken) {
            slots.push({
              start: startIso,
              end: endIso,
              label: formatInZone(cursor, timeZone),
            });
          }
        }
        cursor = slotEnd;
      }
    }
    const next = localDateTimeToUtc(timeZone, y, m, d, 12, 0);
    const tomorrow = new Date(next.getTime() + 36 * 3600 * 1000);
    const tp = zonedParts(tomorrow, timeZone);
    y = Number(tp.year);
    m = Number(tp.month);
    d = Number(tp.day);
  }
  return slots;
}

function weekdayIndexInZone(date, timeZone) {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(date);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].indexOf(wd);
}

export function isSlotOffered(tech, startIso, endIso, booked, now = new Date()) {
  return openSlots(tech, { days: 21, now, booked }).some(
    (s) => s.start === startIso && s.end === endIso
  );
}
