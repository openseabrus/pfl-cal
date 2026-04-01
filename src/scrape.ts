import { parse, type HTMLElement } from "node-html-parser";
import { decode } from "html-entities";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";
import timezone from "dayjs/plugin/timezone.js";

dayjs.extend(utc);
dayjs.extend(timezone);

const PFL_ORIGIN = "https://pflmma.com";
const EVENTS_LISTING = new URL("/events", PFL_ORIGIN);
const AMERICA_NEW_YORK = "America/New_York";
const PLACEHOLDER_COPY = "More info coming soon";
const GOOGLE_CALENDAR_HOST = "calendar.google.com";
const DATE_PARTS_FORMAT = "YYYY-MM-DD HH:mm:ss";
const GOOGLE_DATE_TOKEN_FORMAT = "YYYYMMDDTHHmmss";
const DEFAULT_EVENT_TIMEZONE = AMERICA_NEW_YORK;

const parseInt10 = (value: string): number => Number.parseInt(value, 10);
const unixToEt = (unixSeconds: number) =>
  dayjs.unix(unixSeconds).tz(AMERICA_NEW_YORK);

const SHORT_MONTH: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

export interface ListingRow {
  readonly dateLine: string;
  readonly timeLine: string | undefined;
  readonly title: string;
  readonly location: string;
  readonly ctaText: string;
  readonly ctaAbsoluteUrl: URL;
}

interface EventSession {
  readonly html: string;
  readonly cookies: string;
  readonly csrf: string;
  readonly eventTag: string;
  readonly eventUrl: string;
}

const slugify = (input: string): string =>
  input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);

const mergeCookieHeader = (res: Response): string => {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((cookie) => cookie.split(";")[0]).join("; ");
};

export const isNewsletterUrl = (url: URL): boolean =>
  url.hostname.replace(/^www\./, "") === "pflmma.com" &&
  url.pathname.replace(/\/$/, "") === "/newsletter";

const parseListingDateLine = (
  line: string,
): { readonly month: number; readonly day: number } | null => {
  const dateMatch = line.match(/,\s*([A-Za-z]{3})\s+(\d{1,2})\s*$/);
  if (!dateMatch?.[1] || !dateMatch[2]) return null;
  const monthKey = dateMatch[1].toLowerCase();
  const month = SHORT_MONTH[monthKey];
  if (month === undefined) return null;
  return { month, day: parseInt10(dateMatch[2]) };
};

const to24h = (hour: number, meridiem: string): number => {
  const isPostMeridiem = meridiem.toLowerCase() === "pm";
  let hour24 = hour;
  if (isPostMeridiem && hour24 !== 12) hour24 += 12;
  if (!isPostMeridiem && hour24 === 12) hour24 = 0;
  return hour24;
};

const parse12hParts = (
  hStr: string,
  miRaw: string | undefined,
  ap: string,
): { readonly hour: number; readonly minute: number } => {
  const hour = parseInt10(hStr);
  const minute = miRaw ? parseInt10(miRaw) : 0;
  return { hour: to24h(hour, ap), minute };
};

const parseMainCardTimeFromListingLine = (
  line: string | undefined,
): { readonly hour: number; readonly minute: number } | null => {
  if (!line) return null;
  const mainMatch = line.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*ET[^|]*Main Card/i,
  );
  if (mainMatch?.[1] && mainMatch[3]) {
    return parse12hParts(mainMatch[1], mainMatch[2], mainMatch[3]);
  }
  const tailMain = line.match(
    /Main Card[^|]*?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*ET/i,
  );
  if (tailMain?.[1] && tailMain[3]) {
    return parse12hParts(tailMain[1], tailMain[2], tailMain[3]);
  }
  const etTimes = [...line.matchAll(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*ET/gi)];
  if (etTimes.length === 1) {
    const first = etTimes[0];
    if (first?.[1] && first[3]) {
      return parse12hParts(first[1], first[2], first[3]);
    }
  }
  return null;
};

const unixEtWall = (
  monthIndex: number,
  day: number,
  year: number,
  hour: number,
  minute: number,
): number => {
  const dateStamp = `${year}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const timeStamp = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00`;
  return dayjs
    .tz(`${dateStamp} ${timeStamp}`, DATE_PARTS_FORMAT, AMERICA_NEW_YORK)
    .utc()
    .unix();
};

const unixFromUtcToken = (googleDateToken: string): number | null => {
  const parsed = dayjs.utc(googleDateToken, GOOGLE_DATE_TOKEN_FORMAT, true);
  if (!parsed.isValid()) return null;
  return parsed.unix();
};

const unixFromZonedToken = (
  googleDateToken: string,
  timezoneName: string,
): number | null => {
  const parsed = dayjs.tz(
    googleDateToken,
    GOOGLE_DATE_TOKEN_FORMAT,
    timezoneName,
  );
  if (!parsed.isValid()) return null;
  return parsed.utc().unix();
};

const resolveEventYear = (month: number, day: number): number => {
  const now = dayjs().tz(AMERICA_NEW_YORK);
  let candidateYear = now.year();
  const candidateDate = dayjs.tz(
    `${candidateYear}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    "YYYY-MM-DD",
    AMERICA_NEW_YORK,
  );
  if (candidateDate.isBefore(now.subtract(1, "day").startOf("day"))) {
    candidateYear += 1;
  }
  return candidateYear;
};

const listingDerivedMainUnix = (row: ListingRow): number => {
  const listingDate = parseListingDateLine(row.dateLine);
  if (!listingDate) {
    return dayjs().unix();
  }
  const year = resolveEventYear(listingDate.month, listingDate.day);
  const mainCardTime = parseMainCardTimeFromListingLine(row.timeLine) ?? {
    hour: 21,
    minute: 0,
  };
  return unixEtWall(
    listingDate.month,
    listingDate.day,
    year,
    mainCardTime.hour,
    mainCardTime.minute,
  );
};

const htmlDecodedForMatch = (html: string): string =>
  html.replace(/&amp;/g, "&").replace(/&quot;/g, '"');

const parseCalendarStartToken = (
  token: string,
): {
  readonly dateToken: string;
  readonly isUtc: boolean;
} | null => {
  const tokenMatch = token.match(/^(\d{8}T\d{6})(Z?)$/);
  const dateToken = tokenMatch?.[1];
  if (!dateToken) return null;
  return {
    dateToken,
    isUtc: tokenMatch?.[2] === "Z",
  };
};

const parseGoogleCalendarHref = (html: string): URL | null => {
  const decodedHtml = htmlDecodedForMatch(html);
  const calendarUrlMatch = decodedHtml.match(
    /https:\/\/calendar\.google\.com\/calendar\/render\?[^"'\s]+/i,
  );
  const href = calendarUrlMatch?.[0];
  if (!href) return null;
  try {
    return new URL(href);
  } catch {
    return null;
  }
};

interface GoogleCalendarStart {
  readonly unix: number;
  readonly timezone: string;
}

const parseGoogleCalendarStart = (html: string): GoogleCalendarStart | null => {
  const url = parseGoogleCalendarHref(html);
  if (!url || url.hostname !== GOOGLE_CALENDAR_HOST) return null;
  const datesValue = url.searchParams.get("dates");
  if (!datesValue) return null;
  const startToken = datesValue.split("/")[0];
  if (!startToken) return null;
  const startDetails = parseCalendarStartToken(startToken);
  if (!startDetails) return null;

  const calendarTimezone = url.searchParams.get("ctz") ?? DEFAULT_EVENT_TIMEZONE;
  if (startDetails.isUtc) {
    const unix = unixFromUtcToken(startDetails.dateToken);
    if (unix === null) return null;
    return { unix, timezone: calendarTimezone };
  }
  const unixInCalendarTimezone = unixFromZonedToken(
    startDetails.dateToken,
    calendarTimezone,
  );
  if (unixInCalendarTimezone !== null) {
    return { unix: unixInCalendarTimezone, timezone: calendarTimezone };
  }
  const unixInDefaultTimezone = unixFromZonedToken(
    startDetails.dateToken,
    DEFAULT_EVENT_TIMEZONE,
  );
  if (unixInDefaultTimezone === null) return null;
  return { unix: unixInDefaultTimezone, timezone: DEFAULT_EVENT_TIMEZONE };
};

const parseGoogleCalendarLocation = (html: string): string | null => {
  const decodedHtml = htmlDecodedForMatch(html);
  const locationMatch = decodedHtml.match(/[?&]location=([^&"]+)/);
  const encodedLocation = locationMatch?.[1];
  if (!encodedLocation) return null;
  return decodeURIComponent(encodedLocation.replace(/\+/g, " "));
};

const parseEventPageTitle = (html: string): string | null => {
  const root = parse(html);
  return root.querySelector(".event-info-title")?.textContent?.trim() ?? null;
};

const parseFirstCardUnix = (
  html: string,
  mainUnix: number,
): string | undefined => {
  const root = parse(html);
  const timeElements = root.querySelectorAll(
    ".event-info-box .event-info-time",
  );
  for (const timeElement of timeElements) {
    const timeText = timeElement.textContent ?? "";
    const earlyCardMatch = timeText.match(
      /Early Card:\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)\s*ET/i,
    );
    if (!earlyCardMatch?.[1] || !earlyCardMatch[3]) continue;
    let earlyCardHour = parseInt10(earlyCardMatch[1]);
    const earlyCardMinute = earlyCardMatch[2]
      ? parseInt10(earlyCardMatch[2])
      : 0;
    const earlyCardMeridiem = earlyCardMatch[3];
    earlyCardHour = to24h(earlyCardHour, earlyCardMeridiem);
    const mainCardDateTimeEt = unixToEt(mainUnix);
    let earlyCardUnix = unixEtWall(
      mainCardDateTimeEt.month(),
      mainCardDateTimeEt.date(),
      mainCardDateTimeEt.year(),
      earlyCardHour,
      earlyCardMinute,
    );
    const earlyCardDateTimeEt = unixToEt(earlyCardUnix);
    if (earlyCardDateTimeEt.isAfter(mainCardDateTimeEt)) {
      const previousDay = mainCardDateTimeEt.subtract(1, "day");
      earlyCardUnix = unixEtWall(
        previousDay.month(),
        previousDay.date(),
        previousDay.year(),
        earlyCardHour,
        earlyCardMinute,
      );
    }
    return String(earlyCardUnix);
  }
  return undefined;
};

const boutLinesFromFightCardHtml = (fragment: string): string[] => {
  const root = parse(fragment);
  const rows = root.querySelectorAll(".matchupRow");
  const lines: string[] = [];
  for (const row of rows) {
    const collapsed =
      row.querySelector('[class*="fightcard_collapsed"]') ??
      row.querySelector('[id^="fightCardRow"]');
    if (!collapsed) continue;
    const weightEl = collapsed.querySelector("h5");
    const names = collapsed.querySelectorAll("h4.mb-0");
    const name0 = names.at(0);
    const name1 = names.at(1);
    if (name0 === undefined || name1 === undefined || !weightEl) continue;
    const firstFighterName = name0.textContent?.trim() ?? "";
    const secondFighterName = name1.textContent?.trim() ?? "";
    const weight = weightEl.textContent ?? "";
    const weightNumber = weight.match(/\((\d+)\)/)?.[1] ?? "";
    lines.push(
      decode(`• ${firstFighterName} vs. ${secondFighterName} @${weightNumber}`),
    );
  }
  return lines;
};

const newsletterPlaceholderUrl = (row: ListingRow): URL =>
  new URL(
    `${PFL_ORIGIN}/newsletter#${slugify(`${row.title}-${row.dateLine}`)}`,
  );

const buildPlaceholderEvent = (row: ListingRow): PFLEvent => {
  const unix = listingDerivedMainUnix(row);
  return {
    name: decode(row.title.trim()),
    url: newsletterPlaceholderUrl(row),
    date: String(unix),
    timezone: DEFAULT_EVENT_TIMEZONE,
    location: decode(row.location.trim()),
    fightCard: [PLACEHOLDER_COPY],
    mainCard: [],
    prelims: [],
    earlyPrelims: [],
    prelimsTime: undefined,
    earlyPrelimsTime: undefined,
  };
};

const parseEventHub = (hub: HTMLElement): ListingRow | null => {
  const card = hub.querySelector(".event-card-info");
  if (!card) return null;
  const h6s = card.querySelectorAll("h6");
  const dateLine = h6s[0]?.textContent?.trim() ?? "";
  const timeLine = h6s[1]?.textContent?.trim() || undefined;
  const title = card.querySelector("h3")?.textContent?.trim() ?? "";
  const location = card.querySelector("p.mb-4")?.textContent?.trim() ?? "";
  const ctas = card.querySelectorAll("a.btn-red-outline");
  let ctaEl: HTMLElement | null = null;
  for (const cta of ctas) {
    const txt = cta.textContent?.trim() ?? "";
    if (/^(MATCHUPS|EVENT INFO|EVENT DETAILS)$/i.test(txt)) {
      ctaEl = cta;
      break;
    }
  }
  if (!ctaEl || !dateLine || !title) return null;
  const rawHref = ctaEl.getAttribute("href");
  if (!rawHref) return null;
  const ctaAbsoluteUrl = new URL(rawHref, PFL_ORIGIN);
  const ctaText = ctaEl.textContent?.trim() ?? "";
  return {
    dateLine,
    timeLine,
    title,
    location,
    ctaText,
    ctaAbsoluteUrl,
  };
};

const listingRowKey = (row: ListingRow): string => {
  if (isNewsletterUrl(row.ctaAbsoluteUrl)) {
    return `nl:${slugify(`${row.title}-${row.dateLine}`)}`;
  }
  return row.ctaAbsoluteUrl.pathname;
};

export async function getUpcomingListingRows(): Promise<ListingRow[]> {
  const res = await fetch(EVENTS_LISTING.href, {
    headers: { "User-Agent": "pfl-cal/1.0" },
  });
  const text = await res.text();
  const root = parse(text);
  const upcoming = root.querySelector("#nav-upcoming");
  if (!upcoming) {
    throw new Error("Missing #nav-upcoming on PFL events page");
  }
  const hubs = upcoming.querySelectorAll(".event-hub");
  const byKey = new Map<string, ListingRow>();
  for (const hub of hubs) {
    const row = parseEventHub(hub as HTMLElement);
    if (!row) continue;
    const rowKey = listingRowKey(row);
    if (!byKey.has(rowKey)) byKey.set(rowKey, row);
  }
  return [...byKey.values()];
}

const fetchEventSession = async (eventUrl: string): Promise<EventSession> => {
  const res = await fetch(eventUrl, {
    headers: { "User-Agent": "pfl-cal/1.0" },
  });
  const html = await res.text();
  const cookies = mergeCookieHeader(res);
  const csrf = html.match(/name="_token"\s+value="([^"]+)"/)?.[1] ?? "";
  const eventTag = html.match(/var\s+event_tag\s*=\s*'([^']+)'/)?.[1] ?? "";
  return { html, cookies, csrf, eventTag, eventUrl };
};

const fetchFightCardComponent = async (
  session: EventSession,
): Promise<string> => {
  if (!session.eventTag || !session.csrf) {
    return "";
  }
  const res = await fetch(
    new URL("/ajax/get_fight_card_component", PFL_ORIGIN),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        "X-CSRF-TOKEN": session.csrf,
        "X-Requested-With": "XMLHttpRequest",
        Cookie: session.cookies,
        Referer: session.eventUrl,
        Origin: PFL_ORIGIN.replace(/\/$/, ""),
        Accept: "text/html",
        "User-Agent": "pfl-cal/1.0",
      },
      body: new URLSearchParams({
        event_tag: session.eventTag,
        is_mobile: "0",
      }).toString(),
    },
  );
  const text = await res.text();
  if (text.trim().startsWith("{")) {
    return "";
  }
  return text;
};

const getDetailsForListingRow = async (row: ListingRow): Promise<PFLEvent> => {
  if (isNewsletterUrl(row.ctaAbsoluteUrl)) {
    return buildPlaceholderEvent(row);
  }
  const eventUrl = row.ctaAbsoluteUrl;
  if (
    eventUrl.hostname.replace(/^www\./, "") !== "pflmma.com" ||
    !eventUrl.pathname.startsWith("/event/")
  ) {
    return buildPlaceholderEvent(row);
  }
  let session: EventSession;
  try {
    session = await fetchEventSession(eventUrl.href);
  } catch {
    return buildPlaceholderEvent(row);
  }
  const parsedGoogleCalendarStart = parseGoogleCalendarStart(session.html);
  const mainUnix = parsedGoogleCalendarStart?.unix ?? listingDerivedMainUnix(row);
  const timezone = parsedGoogleCalendarStart?.timezone ?? DEFAULT_EVENT_TIMEZONE;
  const title = parseEventPageTitle(session.html)?.trim() || row.title;
  const location =
    parseGoogleCalendarLocation(session.html)?.trim() || row.location;
  const firstCardUnix = parseFirstCardUnix(session.html, mainUnix);
  let fightLines: string[] = [];
  try {
    const fcHtml = await fetchFightCardComponent(session);
    if (fcHtml) {
      fightLines = boutLinesFromFightCardHtml(fcHtml);
    }
  } catch {
    fightLines = [];
  }
  return {
    name: decode(title),
    url: eventUrl,
    date: String(mainUnix),
    timezone,
    location: decode(location),
    fightCard: fightLines,
    mainCard: [],
    prelims: [],
    earlyPrelims: [],
    prelimsTime: firstCardUnix,
    earlyPrelimsTime: undefined,
  };
};

export async function getAllDetailedEvents(): Promise<PFLEvent[]> {
  const rows = await getUpcomingListingRows();
  const events = await Promise.all(rows.map(getDetailsForListingRow));
  return events.sort((a, b) => parseInt10(a.date) - parseInt10(b.date));
}
