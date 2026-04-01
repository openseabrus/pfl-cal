import { getAllDetailedEvents } from "./scrape.js";
import * as fs from "fs";
import { createEvents, type DateArray, type EventAttributes } from "ics";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import duration from "dayjs/plugin/duration.js";

dayjs.extend(utc);
dayjs.extend(duration);

const parseInt10 = (value: string): number => Number.parseInt(value, 10);
const unixUtc = (unixSeconds: number) => dayjs.unix(unixSeconds).utc();

const wallTimeParts = (unixSec: string): DateArray => {
  const utcDateTime = unixUtc(parseInt10(unixSec));
  return [
    utcDateTime.year(),
    utcDateTime.month() + 1,
    utcDateTime.date(),
    utcDateTime.hour(),
    utcDateTime.minute(),
  ];
};

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

async function createICS(): Promise<void> {
  try {
    const events = await getAllDetailedEvents();
    if (!events?.length) throw new Error("No events retrieved");

    const formattedEvents = events.map((event) =>
      formatEventForCalendar(event, "PFL"),
    );

    console.log("\nDetailed events:");
    console.log(formattedEvents);

    const eventsData = createEvents(formattedEvents).value;
    if (eventsData) fs.writeFileSync("PFL.ics", eventsData);
  } catch (error) {
    console.error(error);
  }
}

function formatEventForCalendar(
  event: PFLEvent,
  calName = "PFL",
): EventAttributes {
  const eventTiming = eventWindow(event);
  const start = wallTimeParts(String(eventTiming.startUnix));
  const duration = durationParts(eventTiming.durationMinutes);
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

  const calendarEvent = {
    start,
    startInputType: "utc" as const,
    startOutputType: "utc" as const,
    duration,
    title,
    description,
    location,
    uid,
    calName,
  };

  return calendarEvent;
}

createICS();
