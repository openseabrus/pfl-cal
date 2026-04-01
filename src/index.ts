import { getAllDetailedEvents } from "./scrape.js";
import * as fs from "fs";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import duration from "dayjs/plugin/duration.js";
import timezone from "dayjs/plugin/timezone.js";
import { getVtimezoneComponent } from "@touch4it/ical-timezones";

dayjs.extend(utc);
dayjs.extend(duration);
dayjs.extend(timezone);

const parseInt10 = (value: string): number => Number.parseInt(value, 10);
const unixUtc = (unixSeconds: number): dayjs.Dayjs => dayjs.unix(unixSeconds).utc();
const ICS_DATE_TIME_FORMAT = "YYYYMMDDTHHmmss";
const PRODID = "-//openseabrus//PFL Calendar//EN";

interface CalendarEvent {
  readonly timezone: string;
  readonly dtStartUnix: number;
  readonly dtEndUnix: number;
  readonly title: string;
  readonly description: string;
  readonly location: string;
  readonly uid: string;
}

const unixFromString = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const unixSeconds = Number(value);
  const parsedUtc = dayjs.unix(unixSeconds).utc();
  if (!parsedUtc.isValid()) return undefined;
  return parsedUtc.unix();
};

const eventWindow = (
  event: PFLEvent,
): { readonly startUnix: number; readonly durationMinutes: number } => {
  const mainStartUnix = unixFromString(event.date);
  const firstCardUnix = unixFromString(event.prelimsTime);

  if (mainStartUnix === undefined && firstCardUnix === undefined) {
    const fallbackNow = dayjs().unix();
    return { startUnix: fallbackNow, durationMinutes: 180 };
  }

  const startUnix =
    mainStartUnix === undefined
      ? (firstCardUnix ?? dayjs().unix())
      : firstCardUnix === undefined
        ? mainStartUnix
        : Math.min(mainStartUnix, firstCardUnix);

  const secondStartUnix = mainStartUnix ?? startUnix;
  const endUnix = secondStartUnix + 3 * 60 * 60;
  const durationMinutes = Math.max(Math.round((endUnix - startUnix) / 60), 180);

  return { startUnix, durationMinutes };
};

const durationParts = (
  totalMinutes: number,
): { readonly hours: number; readonly minutes: number } => {
  const eventDuration = dayjs.duration({ minutes: totalMinutes });
  return {
    hours: eventDuration.hours() + eventDuration.days() * 24,
    minutes: eventDuration.minutes(),
  };
};

const escapeIcsText = (value: string): string =>
  value
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");

const foldIcsLine = (line: string): string => {
  if (line.length <= 75) return line;
  const chunks: string[] = [];
  for (let i = 0; i < line.length; i += 75) {
    chunks.push(i === 0 ? line.slice(i, i + 75) : ` ${line.slice(i, i + 75)}`);
  }
  return chunks.join("\r\n");
};

const toUtcStamp = (unixSeconds: number): string =>
  unixUtc(unixSeconds).format(`${ICS_DATE_TIME_FORMAT}[Z]`);

const toLocalStampInTimezone = (unixSeconds: number, timezoneName: string): string =>
  dayjs.unix(unixSeconds).tz(timezoneName).format(ICS_DATE_TIME_FORMAT);

const resolveVtimezoneBlock = (timezoneName: string): string => {
  const vtimezone = getVtimezoneComponent(timezoneName);
  return (
    vtimezone ??
    [
      "BEGIN:VTIMEZONE",
      `TZID:${timezoneName}`,
      `X-LIC-LOCATION:${timezoneName}`,
      "BEGIN:STANDARD",
      "DTSTART:19700101T000000",
      "TZOFFSETFROM:+0000",
      "TZOFFSETTO:+0000",
      "TZNAME:UTC",
      "END:STANDARD",
      "END:VTIMEZONE",
    ].join("\r\n")
  );
};

const serializeCalendarEvent = (event: CalendarEvent): string => {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${escapeIcsText(event.uid)}`,
    `SUMMARY:${escapeIcsText(event.title)}`,
    `DTSTAMP:${toUtcStamp(dayjs().unix())}`,
    `DTSTART;TZID=${event.timezone}:${toLocalStampInTimezone(event.dtStartUnix, event.timezone)}`,
    `DTEND;TZID=${event.timezone}:${toLocalStampInTimezone(event.dtEndUnix, event.timezone)}`,
    `DESCRIPTION:${escapeIcsText(event.description)}`,
    `LOCATION:${escapeIcsText(event.location)}`,
    "END:VEVENT",
  ];
  return lines.map(foldIcsLine).join("\r\n");
};

const serializeCalendar = (events: CalendarEvent[], calName: string): string => {
  const timezoneNames = [...new Set(events.map((event) => event.timezone))];
  const timezoneLines = timezoneNames.map(resolveVtimezoneBlock).join("\r\n");
  const eventLines = events.map(serializeCalendarEvent).join("\r\n");
  const defaultTimezone = timezoneNames[0] ?? "UTC";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "CALSCALE:GREGORIAN",
    `PRODID:${PRODID}`,
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeIcsText(calName)}`,
    "X-PUBLISHED-TTL:PT1H",
    `X-WR-TIMEZONE:${defaultTimezone}`,
    timezoneLines,
    eventLines,
    "END:VCALENDAR",
    "",
  ];
  return lines.join("\r\n");
};

async function createICS(): Promise<void> {
  try {
    const events = await getAllDetailedEvents();
    if (!events?.length) throw new Error("No events retrieved");

    const formattedEvents = events.map(formatEventForCalendar);

    console.log("\nDetailed events:");
    console.log(formattedEvents);

    const eventsData = serializeCalendar(formattedEvents, "PFL");
    fs.writeFileSync("PFL.ics", eventsData);
  } catch (error) {
    console.error(error);
  }
}

function formatEventForCalendar(
  event: PFLEvent,
): CalendarEvent {
  const eventTiming = eventWindow(event);
  const duration = durationParts(eventTiming.durationMinutes);
  const durationMinutes = duration.hours * 60 + duration.minutes;
  const dtStartUnix = eventTiming.startUnix;
  const dtEndUnix = dtStartUnix + durationMinutes * 60;
  const title = event.name;
  let description = "";

  const mainStart = unixUtc(parseInt10(event.date));
  if (event.fightCard.length) description = `${event.fightCard.join("\n")}\n`;
  if (event.mainCard.length)
    description += `Main Card\n--------------------\n${event.mainCard.join(
      "\n",
    )}\n`;
  if (event.prelims.length) {
    description += "\nPrelims";
    if (event.prelimsTime) {
      const prelimsTime = unixUtc(parseInt10(event.prelimsTime));
      const hoursAgo = mainStart.diff(prelimsTime, "hour", true);
      if (hoursAgo > 0) description += ` (${hoursAgo} hrs before Main)`;
    }
    description += `\n--------------------\n${event.prelims.join("\n")}\n`;
  }
  if (event.earlyPrelims.length) {
    description += "\nEarly Prelims";
    if (event.earlyPrelimsTime) {
      const earlyPrelimsTime = unixUtc(parseInt10(event.earlyPrelimsTime));
      const hoursAgo = mainStart.diff(earlyPrelimsTime, "hour", true);
      if (hoursAgo > 0) description += ` (${hoursAgo} hrs before Main)`;
    }
    description += `\n--------------------\n${event.earlyPrelims.join("\n")}\n`;
  }
  if (description.length) description += "\n";
  description += `${event.url}`;

  const generatedAtUtcLabel = dayjs.utc().format("MMM D, h:mm A [UTC]");
  description += `\n\nAccurate as of ${generatedAtUtcLabel}`;

  const location = event.location;
  const uid = event.url.href;

  const calendarEvent: CalendarEvent = {
    timezone: event.timezone,
    dtStartUnix,
    dtEndUnix,
    title,
    description,
    location,
    uid,
  };

  return calendarEvent;
}

createICS();
