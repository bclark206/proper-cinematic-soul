const TIME_ZONE = "America/New_York";

// Store hours: Mon-Fri 3PM-11PM, Sat-Sun 12PM-11PM
const STORE_HOURS: Record<number, [number, number]> = {
  0: [12 * 60, 23 * 60], // Sunday
  1: [15 * 60, 23 * 60], // Monday
  2: [15 * 60, 23 * 60], // Tuesday
  3: [15 * 60, 23 * 60], // Wednesday
  4: [15 * 60, 23 * 60], // Thursday
  5: [15 * 60, 23 * 60], // Friday
  6: [12 * 60, 23 * 60], // Saturday
};

type ZonedParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  hour: number;
  minute: number;
};

export type PickupTime = { label: string; value: string };

function getZonedParts(date: Date): ZonedParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const lookup = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const weekdayMap: Record<string, number> = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
  };

  return {
    year: Number(lookup.year),
    month: Number(lookup.month),
    day: Number(lookup.day),
    weekday: weekdayMap[lookup.weekday],
    hour: Number(lookup.hour),
    minute: Number(lookup.minute),
  };
}

function getTimeZoneOffsetMinutes(date: Date): number {
  const parts = getZonedParts(date);
  const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return (asUtc - date.getTime()) / 60000;
}

function zonedDateTimeToUtc(year: number, month: number, day: number, minutesAfterMidnight: number): Date {
  const hour = Math.floor(minutesAfterMidnight / 60);
  const minute = minutesAfterMidnight % 60;
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute));
  const offset = getTimeZoneOffsetMinutes(utcGuess);
  return new Date(utcGuess.getTime() - offset * 60000);
}

function addDaysInNewYork(parts: ZonedParts, days: number): ZonedParts {
  const noonUtc = zonedDateTimeToUtc(parts.year, parts.month, parts.day, 12 * 60);
  const shifted = new Date(noonUtc.getTime() + days * 24 * 60 * 60000);
  return getZonedParts(shifted);
}

function formatTime(minutesAfterMidnight: number): string {
  const hours = Math.floor(minutesAfterMidnight / 60);
  const minutes = minutesAfterMidnight % 60;
  const ampm = hours >= 12 ? "PM" : "AM";
  const h = hours % 12 || 12;
  const m = minutes.toString().padStart(2, "0");
  return `${h}:${m} ${ampm}`;
}

function formatDayPrefix(daysFromToday: number): string {
  if (daysFromToday === 0) return "Today";
  if (daysFromToday === 1) return "Tomorrow";
  return new Intl.DateTimeFormat("en-US", { weekday: "short" }).format(
    new Date(Date.now() + daysFromToday * 24 * 60 * 60000)
  );
}

function roundUpToQuarterHour(minutes: number): number {
  return Math.ceil(minutes / 15) * 15;
}

export function getStoreStatus(now = new Date()) {
  const parts = getZonedParts(now);
  const [open, close] = STORE_HOURS[parts.weekday];
  const currentMinutes = parts.hour * 60 + parts.minute;
  const isOpen = currentMinutes >= open && currentMinutes < close;
  const times = generatePickupTimes(now);

  return {
    isOpen,
    hours: `${formatTime(open)} – ${formatTime(close)}`,
    nextOrderingLabel: times[0]?.label ?? `${formatDayPrefix(1)} ${formatTime(open)}`,
  };
}

export function generatePickupTimes(now = new Date(), count = 16): PickupTime[] {
  const nowParts = getZonedParts(now);
  const currentMinutes = nowParts.hour * 60 + nowParts.minute;
  const prepReady = roundUpToQuarterHour(currentMinutes + 25);
  const times: PickupTime[] = [];

  for (let daysFromToday = 0; daysFromToday < 7 && times.length < count; daysFromToday++) {
    const dayParts = addDaysInNewYork(nowParts, daysFromToday);
    const [open, close] = STORE_HOURS[dayParts.weekday];
    const firstSlot = daysFromToday === 0 ? Math.max(open, prepReady) : open;

    for (let slot = firstSlot; slot < close && times.length < count; slot += 15) {
      const utcDate = zonedDateTimeToUtc(dayParts.year, dayParts.month, dayParts.day, slot);
      times.push({
        label: `${formatDayPrefix(daysFromToday)} ${formatTime(slot)}`,
        value: utcDate.toISOString(),
      });
    }
  }

  return times;
}
