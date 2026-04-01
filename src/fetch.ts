import {
  getAllDetailedEvents,
  getUpcomingListingRows,
  isNewsletterUrl,
} from "./scrape.js";
import dayjs from "dayjs";
import utc from "dayjs/plugin/utc.js";

const PREVIEW_BOUTS = 4;
dayjs.extend(utc);
const parseInt10 = (value: string): number => Number.parseInt(value, 10);

const logFetch = async (): Promise<void> => {
  const rows = await getUpcomingListingRows();
  console.log(`\nUpcoming listing rows: ${rows.length}`);
  console.log(
    JSON.stringify(
      rows,
      (_key, value) => (value instanceof URL ? value.href : value),
      2,
    ),
  );

  const events = await getAllDetailedEvents();
  console.log(`\nPFLEvent results: ${events.length}\n`);

  for (const event of events) {
    const placeholder =
      isNewsletterUrl(event.url) && Boolean(event.url.hash?.replace(/^#/, ""));
    const boutCount = event.fightCard.length;
    const preview = event.fightCard.slice(0, PREVIEW_BOUTS);
    const start = dayjs.unix(parseInt10(event.date)).utc().toISOString();
    console.log(
      JSON.stringify(
        {
          placeholder,
          title: event.name,
          startUnix: event.date,
          startIsoUtc: start,
          location: event.location,
          url: event.url.href,
          boutCount,
          boutsPreview: preview,
        },
        null,
        2,
      ),
    );
    console.log("---");
  }
};

logFetch().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
