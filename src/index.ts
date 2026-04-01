import { getAllDetailedEvents } from "./scrape.js";
import * as fs from "fs";
import { createEvents, type DateArray, type EventAttributes } from "ics";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

dayjs.extend(utc);

const wallTimeParts = (unixSec: string): DateArray => {
  const d = dayjs.unix(parseInt(unixSec, 10)).utc();
  return [d.year(), d.month() + 1, d.date(), d.hour(), d.minute()];
};

const unixFromString = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return undefined;
  return parsed;
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
  const durationMinutes = Math.max(
    Math.round((endUnix - startUnix) / 60),
    180,
  );

  return { startUnix, durationMinutes };
};

const durationParts = (
  totalMinutes: number,
): { readonly hours: number; readonly minutes: number } => ({
  hours: Math.floor(totalMinutes / 60),
  minutes: totalMinutes % 60,
});

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
  const window = eventWindow(event);
  const start = wallTimeParts(String(window.startUnix));
  const duration = durationParts(window.durationMinutes);
  const title = event.name;
  let description = "";

  const mainStart = dayjs.unix(parseInt(event.date, 10));
  if (event.fightCard.length) description = `${event.fightCard.join("\n")}\n`;
  if (event.mainCard.length)
    description += `Main Card\n--------------------\n${event.mainCard.join(
      "\n",
    )}\n`;
  if (event.prelims.length) {
    description += "\nPrelims";
    if (event.prelimsTime) {
      const prelimsTime = dayjs.unix(parseInt(event.prelimsTime, 10));
      const hoursAgo = mainStart.diff(prelimsTime, "hour", true);
      if (hoursAgo > 0) description += ` (${hoursAgo} hrs before Main)`;
    }
    description += `\n--------------------\n${event.prelims.join("\n")}\n`;
  }
  if (event.earlyPrelims.length) {
    description += "\nEarly Prelims";
    if (event.earlyPrelimsTime) {
      const earlyPrelimsTime = dayjs.unix(
        parseInt(event.earlyPrelimsTime, 10),
      );
      const hoursAgo = mainStart.diff(earlyPrelimsTime, "hour", true);
      if (hoursAgo > 0) description += ` (${hoursAgo} hrs before Main)`;
    }
    description += `\n--------------------\n${event.earlyPrelims.join("\n")}\n`;
  }
  if (description.length) description += "\n";
  description += `${event.url}`;

  const dateTimestr = new Date().toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    timeZone: "UTC",
    timeZoneName: "short",
  });
  description += `\n\nAccurate as of ${dateTimestr}`;

  const location = event.location;
  const uid = event.url.href;

  const calendarEvent = {
    start,
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
