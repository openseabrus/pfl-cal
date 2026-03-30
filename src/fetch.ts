import {
  getAllDetailedEvents,
  getUpcomingListingRows,
  isNewsletterUrl,
} from "./scrape.js";

const PREVIEW_BOUTS = 4;

const logFetch = async (): Promise<void> => {
  const rows = await getUpcomingListingRows();
  console.log(`\nUpcoming listing rows: ${rows.length}`);
  console.log(
    JSON.stringify(
      rows,
      (_, v) => (v instanceof URL ? v.href : v),
      2,
    ),
  );

  const events = await getAllDetailedEvents();
  console.log(`\nPFLEvent results: ${events.length}\n`);

  for (const e of events) {
    const placeholder =
      isNewsletterUrl(e.url) && Boolean(e.url.hash?.replace(/^#/, ""));
    const boutCount = e.fightCard.length;
    const preview = e.fightCard.slice(0, PREVIEW_BOUTS);
    const start = new Date(parseInt(e.date, 10) * 1000).toISOString();
    console.log(
      JSON.stringify(
        {
          placeholder,
          title: e.name,
          startUnix: e.date,
          startIsoUtc: start,
          location: e.location,
          url: e.url.href,
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

logFetch().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
