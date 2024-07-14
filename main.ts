import { parse } from "https://deno.land/x/xml/mod.ts";
import { DB } from "https://deno.land/x/sqlite/mod.ts";
import { Eta } from "https://deno.land/x/eta/src/index.ts";
import Logger from "https://deno.land/x/logger/logger.ts";

import { join } from "https://deno.land/std/path/mod.ts";

const logger = new Logger();

const SETTINGS = {
  PORT: Number(Deno.env.get("TUBE_PORT")) || 8000,

  FEEDS_PATH: Deno.env.get("TUBE_FEEDS_PATH") || "./feeds.txt",

  /**
   * Path to store internal data
   */
  DATA_PATH: "./data",

  /**
   * Path to store public files
   */
  PUBLIC_PATH: Deno.env.get("TUBE_PUBLIC_PATH") || "./public",
  /**
   * Cron pattern to build the html static file
   */
  CRON_FEED_BUILDER: Deno.env.get("TUBE_CRON_FEED_BUILDER") || "*/5 * * * *",

  /**
   * Cron pattern to update the queue, this is the cron that add each channel to the queue to be fetched
   */
  CRON_QUEUE_UPDATE: Deno.env.get("TUBE_CRON_QUEUE_UPDATE") || "0 * * * *",

  /**
   * The interval in hour to fetch the RSS feed for each channel,
   * this is to avoid to make too many requests in a short period of time.
   * Make sure the value is equal or less than the CRON_QUEUE_UPDATE, otherwise the queue will never be fully emptied
   * Example:
   *    If you have 500 channels and the setting is set to 1, all channel will be fetched in 1 hour,
   *    each espaced by about 7.2 seconds ((60 * (60 * 1)) / 500) = 7.2.
   *
   *    If you want all channels to be fetched in 30 minutes, set this to 0.5
   *    ((60 * (60 * 0.5)) / 500) = 1 query every 3.6 seconds
   */
  FETCH_INTERVAL: Number(Deno.env.get("TUBE_FETCH_INTERVAL")) || 0.5,

  YOUTUBE_FRONTEND: Deno.env.get("TUBE_YOUTUBE_FRONTEND") || "https://www.youtube.com/watch?v=",
};

type FeedEntry = {
  "yt:videoId": string;
  title: string;
  link: { "@href": string };
  published: string;
  author: {
    name: string;
    uri: string;
  };
  "media:group": {
    "media:thumbnail": { "@url": string };
  };
};

type Feed = {
  feed: {
    title: string;
    "yt:channelId": string;
    entry: FeedEntry | FeedEntry[];
  };
};

await Deno.mkdir(SETTINGS.DATA_PATH, { recursive: true });
await Deno.mkdir(SETTINGS.PUBLIC_PATH, { recursive: true });

const db = new DB(join(SETTINGS.DATA_PATH, "db.sqlite3"));
const kv = await Deno.openKv(join(SETTINGS.DATA_PATH, "./kv.store"));

db.execute(`
  CREATE TABLE IF NOT EXISTS channels (
    id  TEXT PRIMARY KEY,
    fetched_at TEXT
    status TEXT
  );
  CREATE TABLE IF NOT EXISTS videos (
    id  TEXT PRIMARY KEY,
    channel_id TEXT,
    published_at TEXT
  )
`);

const postHandler = async (req: Request) => {
  const params = new URL(req.url).searchParams;

  // ?method=add&channel_id=UCYcJNtSv9jSCB0tWMb09O_Q
  switch (params.get("method")) {
    case "add": {
      const id = params.get("channel_id");
      if (!id) {
        return new Response("channel_id is required", { status: 400 });
      }

      const exists = db.query("SELECT * FROM channels WHERE id = ?", [id]);
      if (exists.length > 0) {
        return new Response("ALREADY_EXISTS", { status: 200 });
      }

      db.query("INSERT INTO channels (id) VALUES (?)", [id]);

      await Deno.writeTextFile(SETTINGS.FEEDS_PATH, `${id}\n`, { append: true });

      return new Response("OK", { status: 200 });
    }
  }

  return new Response("Not Found", { status: 404 });
};

const getHandler = async () => {
  const html = await Deno.open(join(SETTINGS.PUBLIC_PATH, "index.html"));
  return new Response(html.readable, { status: 200 });
};

const handlers = {
  POST: postHandler,
  GET: getHandler,
};

function httpHandler(req: Request) {
  logger.info(`[httpGandler] ${req.method} ${req.url}`);
  const method = req.method as "GET" | "POST";
  try {
    if (method in handlers) {
      return handlers[method](req);
    }

    return new Response("Method Not Allowed", { status: 405 });
  } catch (error) {
    logger.error("Error", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}

function cronHandlerUpdateQueue() {
  const channels = db.query(
    "SELECT * FROM channels WHERE status = 'fetched' OR status IS NULL ORDER BY fetched_at ASC"
  ) as [string, string][];
  const delay = ((60 * (60 * SETTINGS.FETCH_INTERVAL)) / channels.length) * 1000;

  for (const channel of channels) {
    const d = delay * channels.indexOf(channel);
    kv.enqueue({ channel_id: channel[0] }, { delay: d });
    db.query("UPDATE channels SET status = 'queued' WHERE id = ?", [channel[0]]);
    logger.info(
      `[cronHandlerUpdateQueue] Channel "${channel[0]}" to queue, will be fetched at ${new Date(
        Date.now() + d
      ).toISOString()}`
    );
  }

  logger.info(`[cronHandlerUpdateQueue] Added ${channels.length} channek to queue`);
}

async function queueHandlerRSSFetcher({ channel_id }: { channel_id: string }) {
  let data: Feed;
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel_id}`;

  try {
    const rss = await fetch(url);
    const xml = await rss.text();
    data = parse(xml) as unknown as Feed;
    await Deno.writeTextFile(`./data/${channel_id}.json`, JSON.stringify(data, null, 2));
    logger.info(`[queueHandlerRSSFetcher] Fetched RSS for "${data.feed.title}" (${channel_id})`);
  } catch (e) {
    logger.error(`[queueHandlerRSSFetcher] Failed to fetch RSS for ${channel_id}`, e);
    return;
  }

  try {
    if (!data.feed.entry) {
      logger.info(`[queueHandlerRSSFetcher] No videos found for "${data.feed.title}" (${channel_id})`);
      return;
    }

    const videos = Array.isArray(data.feed.entry) ? data.feed.entry : [data.feed.entry];
    for (const video of videos) {
      const exists = db.query("SELECT * FROM videos WHERE id = ?", [video["yt:videoId"]]);
      if (exists.length > 0) {
        continue;
      }
      db.query("INSERT INTO videos (id, channel_id, published_at) VALUES (?, ?, ?)", [
        video["yt:videoId"],
        channel_id,
        video.published,
      ]);
      logger.info(
        `[queueHandlerRSSFetcher] Added video "${video.title} (${video["yt:videoId"]})" / "${data.feed.title}" (${channel_id})`
      );
    }
  } catch (e) {
    logger.error(`[queueHandlerRSSFetcher] Failed to add video for ${channel_id}`, e);
    return;
  }

  db.query("UPDATE channels SET status = 'fetched', fetched_at = datetime('now') WHERE id = ?", [channel_id]);
}

async function cronHandlerFeedBuilder() {
  logger.info("[cronHandlerFeedBuilder] Building feed");
  const now = Date.now();

  const response = [];
  const videos = db.query("SELECT * FROM videos ORDER BY published_at DESC limit 300;") as [string, string, string][];

  const cache = new Map<string, Feed>();
  for (const [id, channel_id] of videos) {
    /**
     * Set data to cache if not cached yet
     */
    if (!cache.has(channel_id)) {
      try {
        const data = JSON.parse(await Deno.readTextFile(`./data/${channel_id}.json`));
        cache.set(channel_id, data);
      } catch (e) {
        logger.error(`[cronHandlerFeedBuilder] Failed to read data from file for ${channel_id}`, e);
        continue;
      }
    }

    /**
     * Get feed data from cache
     */
    const feed = cache.get(channel_id);
    if (!feed) {
      logger.error(`[cronHandlerFeedBuilder] Failed to get feed data from cache for ${channel_id}`);
      continue;
    }

    const entries = Array.isArray(feed.feed.entry) ? feed.feed.entry : [feed.feed.entry];
    const video = entries.find(entry => entry["yt:videoId"] === id);

    if (!video) {
      continue;
    }

    response.push({
      title: video.title,
      video_id: video["yt:videoId"],
      link: `${SETTINGS.YOUTUBE_FRONTEND}${video["yt:videoId"]}`,
      published_at: video.published,
      author: video.author,
      thumbnail: video["media:group"]["media:thumbnail"]["@url"],
    });
  }

  const template = await Deno.readTextFile("./index.eta");
  const eta = new Eta();
  const html = await eta.renderString(template, { data: response });
  await Deno.writeFile(join(SETTINGS.PUBLIC_PATH, "./index.html"), new TextEncoder().encode(html));
  logger.info(`[cronHandlerFeedBuilder] Feed built in ${Date.now() - now}ms`);
}

async function migrate() {
  const feeds = new TextDecoder().decode(await Deno.readFile(SETTINGS.FEEDS_PATH)).split(/\r?\n/);
  const stats = { added: 0, removed: 0 };

  const stored = new Set((db.query("SELECT id FROM channels") as [string][]).map(c => c[0]));

  for (const id of feeds) {
    if (!id) continue;

    if (stored.has(id)) {
      stored.delete(id);
      continue;
    }

    const exists = db.query("SELECT * FROM channels WHERE id = ?", [id]);
    if (exists.length > 0) {
      continue;
    }

    db.query("INSERT INTO channels (id) VALUES (?)", [id]);
    stats.added++;
  }

  for (const id of stored) {
    db.query("DELETE FROM channels WHERE id = ?", [id]);
    stats.removed++;
  }

  logger.info(`[migrate] Added ${stats.added} channels, removed ${stats.removed} channels`);
}

/**
 * Main
 */

await migrate();

Deno.cron("UPDATE_QUEUE", SETTINGS.CRON_QUEUE_UPDATE, cronHandlerUpdateQueue);
Deno.cron("FEED_BUILDER", SETTINGS.CRON_FEED_BUILDER, cronHandlerFeedBuilder);
kv.listenQueue(queueHandlerRSSFetcher);

cronHandlerFeedBuilder();
cronHandlerUpdateQueue();

await Deno.serve({ port: SETTINGS.PORT, hostname: "0.0.0.0" }, httpHandler);
