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

const slugify = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 120);

const mergeCookieHeader = (res: Response): string => {
  const raw = res.headers.getSetCookie?.() ?? [];
  return raw.map((c) => c.split(";")[0]).join("; ");
};

export const isNewsletterUrl = (url: URL): boolean =>
  url.hostname.replace(/^www\./, "") === "pflmma.com" &&
  url.pathname.replace(/\/$/, "") === "/newsletter";

const parseListingDateLine = (
  line: string,
): { readonly month: number; readonly day: number } | null => {
  const m = line.match(/,\s*([A-Za-z]{3})\s+(\d{1,2})\s*$/);
  if (!m?.[1] || !m[2]) return null;
  const monKey = m[1].toLowerCase();
  const month = SHORT_MONTH[monKey];
  if (month === undefined) return null;
  return { month, day: parseInt(m[2], 10) };
};

const to24h = (hour: number, ap: string): number => {
  const pm = ap.toLowerCase() === "pm";
  let h = hour;
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return h;
};

const parse12hParts = (
  hStr: string,
  miRaw: string | undefined,
  ap: string,
): { readonly hour: number; readonly minute: number } => {
  const hour = parseInt(hStr, 10);
  const minute = miRaw ? parseInt(miRaw, 10) : 0;
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
  const any = line.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)\s*ET/i);
  if (any?.[1] && any[3]) {
    return parse12hParts(any[1], any[2], any[3]);
  }
  return null;
};

const unixEtWall = (
  month0: number,
  day: number,
  year: number,
  hour: number,
  minute: number,
): number => {
  const y = `${year}-${String(month0 + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  const hm = `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
  return dayjs.tz(`${y} ${hm}`, "YYYY-MM-DD HH:mm", AMERICA_NEW_YORK).unix();
};

const resolveEventYear = (month: number, day: number): number => {
  const now = dayjs().tz(AMERICA_NEW_YORK);
  let y = now.year();
  let candidate = dayjs.tz(
    `${y}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    "YYYY-MM-DD",
    AMERICA_NEW_YORK,
  );
  if (candidate.isBefore(now.subtract(1, "day").startOf("day"))) {
    y += 1;
  }
  return y;
};

const listingDerivedMainUnix = (row: ListingRow): number => {
  const md = parseListingDateLine(row.dateLine);
  if (!md) {
    return dayjs().unix();
  }
  const year = resolveEventYear(md.month, md.day);
  const t = parseMainCardTimeFromListingLine(row.timeLine) ?? {
    hour: 21,
    minute: 0,
  };
  return unixEtWall(md.month, md.day, year, t.hour, t.minute);
};

const htmlDecodedForMatch = (html: string): string =>
  html.replace(/&amp;/g, "&").replace(/&quot;/g, '"');

const parseGoogleCalendarStartUnix = (html: string): number | null => {
  const dec = htmlDecodedForMatch(html);
  const m = dec.match(/dates=(\d{8})T(\d{6})/);
  const ds = m?.[1];
  const ts = m?.[2];
  if (!ds || !ts) return null;
  const y = parseInt(ds.slice(0, 4), 10);
  const mo = parseInt(ds.slice(4, 6), 10) - 1;
  const d = parseInt(ds.slice(6, 8), 10);
  const hh = parseInt(ts.slice(0, 2), 10);
  const mi = parseInt(ts.slice(2, 4), 10);
  return unixEtWall(mo, d, y, hh, mi);
};

const parseGoogleCalendarLocation = (html: string): string | null => {
  const dec = htmlDecodedForMatch(html);
  const m = dec.match(/[?&]location=([^&"]+)/);
  const loc = m?.[1];
  if (!loc) return null;
  return decodeURIComponent(loc.replace(/\+/g, " "));
};

const parseEventPageTitle = (html: string): string | null => {
  const root = parse(html);
  return (
    root.querySelector(".event-info-title")?.textContent?.trim() ?? null
  );
};

const parseEarlyCardUnix = (html: string, mainUnix: number): string | undefined => {
  const root = parse(html);
  const times = root.querySelectorAll(".event-info-box .event-info-time");
  for (const el of times) {
    const text = el.textContent ?? "";
    const m = text.match(
      /Early Card:\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*ET/i,
    );
    if (!m?.[1] || !m[2] || !m[3]) continue;
    let h = parseInt(m[1], 10);
    const mi = parseInt(m[2], 10);
    const ap = m[3];
    h = to24h(h, ap);
    const main = dayjs.unix(mainUnix).tz(AMERICA_NEW_YORK);
    const u = unixEtWall(main.month(), main.date(), main.year(), h, mi);
    return String(u);
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
    const n0 = names.at(0);
    const n1 = names.at(1);
    if (n0 === undefined || n1 === undefined || !weightEl) continue;
    const a = n0.textContent?.trim() ?? "";
    const b = n1.textContent?.trim() ?? "";
    const wt = weightEl.textContent ?? "";
    const wNum = wt.match(/\((\d+)\)/)?.[1] ?? "";
    lines.push(decode(`• ${a} vs. ${b} @${wNum}`));
  }
  return lines;
};

const newsletterPlaceholderUrl = (row: ListingRow): URL =>
  new URL(`${PFL_ORIGIN}/newsletter#${slugify(`${row.title}-${row.dateLine}`)}`);

const buildPlaceholderEvent = (row: ListingRow): PFLEvent => {
  const unix = listingDerivedMainUnix(row);
  return {
    name: decode(row.title.trim()),
    url: newsletterPlaceholderUrl(row),
    date: String(unix),
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
  for (const a of ctas) {
    const txt = a.textContent?.trim() ?? "";
    if (/^(MATCHUPS|EVENT INFO|EVENT DETAILS)$/i.test(txt)) {
      ctaEl = a;
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
    throw new Error('Missing #nav-upcoming on PFL events page');
  }
  const hubs = upcoming.querySelectorAll(".event-hub");
  const byKey = new Map<string, ListingRow>();
  for (const hub of hubs) {
    const row = parseEventHub(hub as HTMLElement);
    if (!row) continue;
    const k = listingRowKey(row);
    if (!byKey.has(k)) byKey.set(k, row);
  }
  return [...byKey.values()];
};

const fetchEventSession = async (eventUrl: string): Promise<EventSession> => {
  const res = await fetch(eventUrl, {
    headers: { "User-Agent": "pfl-cal/1.0" },
  });
  const html = await res.text();
  const cookies = mergeCookieHeader(res);
  const csrf =
    html.match(/name="_token"\s+value="([^"]+)"/)?.[1] ?? '';
  const eventTag = html.match(/var\s+event_tag\s*=\s*'([^']+)'/)?.[1] ?? '';
  return { html, cookies, csrf, eventTag, eventUrl };
};

const fetchFightCardComponent = async (
  session: EventSession,
): Promise<string> => {
  if (!session.eventTag || !session.csrf) {
    return "";
  }
  const res = await fetch(new URL("/ajax/get_fight_card_component", PFL_ORIGIN), {
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
  });
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
  let mainUnix =
    parseGoogleCalendarStartUnix(session.html) ?? listingDerivedMainUnix(row);
  const title =
    parseEventPageTitle(session.html)?.trim() || row.title;
  const location =
    parseGoogleCalendarLocation(session.html)?.trim() || row.location;
  const earlyUnix = parseEarlyCardUnix(session.html, mainUnix);
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
    location: decode(location),
    fightCard: fightLines,
    mainCard: [],
    prelims: [],
    earlyPrelims: [],
    prelimsTime: earlyUnix,
    earlyPrelimsTime: undefined,
  };
};

export async function getAllDetailedEvents(): Promise<PFLEvent[]> {
  const rows = await getUpcomingListingRows();
  const events = await Promise.all(rows.map(getDetailsForListingRow));
  return events.sort((a, b) => parseInt(a.date, 10) - parseInt(b.date, 10));
}
