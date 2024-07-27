import { parse } from "https://deno.land/x/xml/mod.ts";
import { Eta } from "https://deno.land/x/eta/src/index.ts";
import Logger from "https://deno.land/x/logger/logger.ts";
import { DOMParser } from "https://deno.land/x/deno_dom/deno-dom-wasm.ts";
import { join } from "https://deno.land/std/path/mod.ts";

const UA = "curl/7.64.1";
const logger = new Logger();

const SETTINGS = {
  PORT: Number(Deno.env.get("TUBE_PORT")) || 8000,

  /**
   * Path to store internal data
   */
  DATA_PATH: "./data",
  SUBSCRIPTIONS_FILE: "./data/subscriptions",

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
   * Fetch interval in seconds, used to add a delay between each channel fetch to avoid rate limit
   * or requests bottleneck.
   *
   * In case there is a lot of channels to fetch,
   * makes sure the total time to fetch all channels is lower than the CRON_QUEUE_UPDATE interval.
   * Ex:
   *  3600 channels with 1 second interval will take 1 hours to fetch all channels.
   *  1000 channels with 1 second interval will take ~16 minutes to fetch all channels.
   */
  FETCH_INTERVAL: Number(Deno.env.get("TUBE_FETCH_INTERVAL")) || 1,

  /**
   * If true, will allow shorts to be processed and added in the feed.
   */
  ALLOW_SHORTS: !!JSON.parse(Deno.env.get("TUBE_ALLOW_SHORTS") || "false"),

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

const Cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, ",
    "Access-Control-Allow-Headers": "*",
}

const ResponseHeaders = {
  headers: {
    ...Cors
  }
}

const HTTPResponse = {
  OK: new Response("OK", { status: 200, ...ResponseHeaders }),
  ALREADY_EXISTS: new Response("ALREADY_EXISTS", { status: 409, ...ResponseHeaders }),
  BAD_REQUEST: (reason: string) => new Response("Bad Request: " + reason, { status: 400, ...ResponseHeaders }),
  NOT_FOUND: new Response("Not Found", { status: 404, ...ResponseHeaders }),
  METHOD_NOT_ALLOWED: new Response("Method Not Allowed", { status: 405, ...ResponseHeaders }),
  INTERNAL_SERVER_ERROR: new Response("Internal Server Error", { status: 500, ...ResponseHeaders }),
};

enum PostMethod {
  AddById = "add_by_id",
  AddByURL = "add_by_url",
  AddToWatchlist = "add_to_watchlist",
  DeleteById = "delete_by_id",
}

const Manager = {
  async add_by_id(id: string): Promise<Response> {
    const channels = await Helpers.get_channels();

    if (channels.indexOf(id) !== -1) {
      return HTTPResponse.ALREADY_EXISTS;
    }

    await Deno.writeTextFile(SETTINGS.SUBSCRIPTIONS_FILE, `${id}\n`, {
      append: true,
    });

    await Helpers.enqueue(id, 0);

    return HTTPResponse.OK;
  },
  async add_by_url(url: string): Promise<Response> {
    const re = [
      /(?:youtu\.be|youtube\.com)\/@(?<username>\w+)/,
      /(?:youtu\.be|youtube\.com)\/(?:shorts|embed)\/(?<video_id>\w+)/,
      /(?:youtu\.be|youtube\.com)\/watch\?v=(?<video_id>\w+)/,
      /(?:youtu\.be|youtube\.com)\/channel\/(?<channel_id>[\w-]+)/,
    ];

    const matches = re.reduce((sum, r) => {
      const match = r.exec(url);
      return match ? Object.assign(sum, match.groups) : sum;
    }, {} as { [key in "username" | "channel_id" | "video_id"]?: string });

    if (matches.channel_id) {
      return Manager.add_by_id(matches.channel_id);
    }

    if (matches.video_id) {
      return HTTPResponse.BAD_REQUEST("URL of a video is not supported yet");
    }

    if (matches.username) {
      const response = await fetch(url, {
        headers: {
          "User-Agent": UA,
        },
      });
      const html = await response.text();
      const parser = new DOMParser();
      const doc = parser.parseFromString(html, "text/html");
      const element = doc.querySelector("link[rel='canonical']");
      const link = element?.getAttribute("href");

      if (link) {
        return Manager.add_by_url(link);
      }

      return HTTPResponse.NOT_FOUND;
    }

    return HTTPResponse.BAD_REQUEST("Invalid URL");
  },
};

const postHandler = async (req: Request) => {
  const params = new URL(req.url).searchParams;

  switch (params.get("method")) {
    case PostMethod.AddById: {
      const id = params.get("channel_id");
      if (!id) {
        return new Response("channel_id is required", { status: 400 });
      }

      try {
        return Manager.add_by_id(id);
      } catch (_e) {
        return HTTPResponse.INTERNAL_SERVER_ERROR;
      }
    }
    case PostMethod.AddByURL: {
      const url = params.get("url");

      if (!url) {
        return HTTPResponse.BAD_REQUEST("url is required");
      }

      try {
        return Manager.add_by_url(url);
      } catch (_e) {
        return HTTPResponse.INTERNAL_SERVER_ERROR;
      }

    }
    case PostMethod.AddToWatchlist: {
      const video_id = params.get("video_id");

      if (!video_id) {
        return HTTPResponse.BAD_REQUEST("video_id is required");
      }

      const record = await kv.get(["watchlist", video_id]);
      if (record.value !== null) {
        return HTTPResponse.ALREADY_EXISTS;
      }

      await kv.set(["watchlist", video_id], { addedAt: new Date() });
      return new Response("OK", { status: 200 });
    }
    case PostMethod.DeleteById: {
      const id = params.get("channel_id");
      if (!id) {
        return HTTPResponse.BAD_REQUEST("channel_id is required");
      }

      const channels = await Helpers.get_channels();
      const index = channels.indexOf(id);
      if (index > -1) {
        channels.splice(index, 1);
        await Deno.writeTextFile(SETTINGS.SUBSCRIPTIONS_FILE, channels.join("\n"));
      }

      // Cleanup KV and FS
      const rss = JSON.parse(await Deno.readTextFile(`./data/${id}.json`)) as Feed;
      const entries = Array.isArray(rss.feed.entry) ? rss.feed.entry : [rss.feed.entry];
      for (const entry of entries) {
        await kv.delete(["video", entry["yt:videoId"]]);
      }
      await Deno.remove(`./data/${id}.json`);
      await kv.delete(["channel", id]);

      const redirect = params.get("redirect");

      if (redirect) {
        const headers = new Headers({
          location: new URL(req.url).origin + redirect,
        });
        return new Response(null, {
          status: 302,
          headers,
        });
      }

      return HTTPResponse.OK;
    }
  }

  return HTTPResponse.METHOD_NOT_ALLOWED;
};

const getHandler = async (req: Request) => {
  switch (new URL(req.url).pathname) {
    case "/": {
      const html = await Deno.open(join(SETTINGS.PUBLIC_PATH, "index.html"));
      return new Response(html.readable, { status: 200 });
    }
    case "/manage": {
      const channels = await Helpers.get_channels();
      const data: { id: string; title: string; last_at: string }[] = [];

      for (const channel_id of channels) {
        try {
          const rss = JSON.parse(await Deno.readTextFile(`./data/${channel_id}.json`)) as Feed;
          data.push({
            id: channel_id,
            title: rss.feed.title,
            last_at: Array.isArray(rss.feed.entry) ? rss.feed.entry[0].published : rss.feed.entry.published,
          });
        } catch (_e) {
          data.push({
            id: channel_id,
            title: "N/A (not fetched yet)",
            last_at: new Date(0).toISOString(),
          });
        }
      }

      data.sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime());

      const html = await eta.render("./manage.eta", { data });
      return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
    }
    default: {
      return HTTPResponse.NOT_FOUND;
    }
  }
};

const handlers = {
  POST: postHandler,
  GET: getHandler,
};

function httpHandler(req: Request) {
  logger.info(`[httpHandler] ${req.method} ${req.url}`);
  const method = req.method as "GET" | "POST";
  try {
    if (method in handlers) {
      return handlers[method](req);
    }

    return HTTPResponse.METHOD_NOT_ALLOWED;
  } catch (error) {
    logger.error("Error", error);
    return HTTPResponse.INTERNAL_SERVER_ERROR;
  }
}

const Helpers = {
  /**
   * Get all channels ids from the feeds file
   */
  async get_channels() {
    return new TextDecoder()
      .decode(await Deno.readFile(SETTINGS.SUBSCRIPTIONS_FILE))
      .split(/\r?\n/)
      .filter((v) => v !== "");
  },

  /**
   * Check if a video is a short or a regular video.
   * A short will return 200 status code, a regular video will return a redirect.
   *
   * Doing that way is a workaround to avoid using the youtube API, however it may be detected and blocked by youtube
   * when initiating the app with a lot of channels.
   *
   * XXX: Detecting short could be done by doing some analysis on the thumbnail.
   */
  async is_short(videoId: string) {
    const response = await fetch(`https://www.youtube.com/shorts/${videoId}`, {
      redirect: "manual",
      headers: {
        "User-Agent": UA,
      },
    });
    return response.status === 200;
  },

  is_past(date: string) {
    return new Date(date).getTime() < startedAt - 24 * 60 * 60 * 1000;
  },

  ms(value: string): number {
    const match = value.match(/([0-9.]+)([a-z]+)/);
    if (!match) return 0;

    const [, number, unit] = match;

    const mapping = {
      s: (v) => v * 1000,
      sec: (v) => v * 1000,

      m: (v) => v * 60 * 1000,
      min: (v) => v * 60 * 1000,

      h: (v) => v * 60 * 60 * 1000,
      hour: (v) => v * 60 * 60 * 1000,

      d: (v) => v * 24 * 60 * 60 * 1000,
      day: (v) => v * 24 * 60 * 60 * 1000,
    } as Record<string, (v: number) => number>;

    return unit in mapping ? mapping[unit](parseFloat(number)) : 0;
  },

  enqueue(channel_id: string, delay: number) {
    return kv
      .atomic()
      .set(["channel", channel_id], { queuedAt: new Date() }, { expireIn: Helpers.ms("1d") })
      .enqueue({ channel_id }, { delay })
      .commit();
  },
};

async function cronHandlerUpdateQueue() {
  const channels = await Helpers.get_channels();

  const delay = SETTINGS.FETCH_INTERVAL * 1000;
  const stats = { added: 0 };

  for (const channel of channels) {
    const record = await kv.get(["channel", channel]);
    if (record.value) continue;

    const d = delay * channels.indexOf(channel);
    await Helpers.enqueue(channel, d);
    stats.added++;
  }

  const total = (delay * stats.added) / 1000 / 60;
  logger.info(`[cronHandlerUpdateQueue] Added ${stats.added} channel to queue`);
  logger.info(`[cronHandlerUpdateQueue] Update will take roughly ${total} minutes`);
}

async function queueHandlerRSSFetcher({ channel_id }: { channel_id: string }) {
  let data: Feed;
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel_id}`;

  await kv.delete(["channel", channel_id]);

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
      const record = await kv.get(["video", video["yt:videoId"]]);

      if (record.value !== null) {
        continue;
      }

      if (Helpers.is_past(video.published)) {
        continue;
      }

      const is_short = await Helpers.is_short(video["yt:videoId"]);
      if (!SETTINGS.ALLOW_SHORTS && is_short) {
        continue;
      }

      try {
        await kv.set(
          ["video", video["yt:videoId"]],
          {
            channel_id,
            published_at: video.published,
            is_short: is_short,
          },
          {
            expireIn: Helpers.ms("7d"),
          },
        );
      } catch (e) {
        logger.error(
          `[queueHandlerRSSFetcher] Failed to insert video "${video.title}" (${video["yt:videoId"]}) for channel ${channel_id}`,
          e,
        );
        return;
      }

      logger.info(
        `[queueHandlerRSSFetcher] Added ${is_short ? "short" : "video"} "${video.title} (${video["yt:videoId"]})" / "${data.feed.title}" (${channel_id})`,
      );
    }
  } catch (e) {
    logger.error(`[queueHandlerRSSFetcher] Failed to add video for channel ${channel_id}`, e);
    return;
  }
}

async function cronHandlerFeedBuilder() {
  logger.info("[cronHandlerFeedBuilder] Building feed");
  const now = Date.now();

  const response = [];

  const videos = kv.list<{ channel_id: string; is_short: boolean }>({ prefix: ["video"] });

  const cache = new Map<string, Feed>();
  for await (
    const {
      key,
      value: { channel_id, is_short },
    } of videos
  ) {
    const id = key.at(-1);
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
    const video = entries.find((entry) => entry["yt:videoId"] === id);

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
      // is_in_watchlist: watchlist.some(([videoId]) => videoId === video["yt:videoId"]),
      is_short,
    });
  }

  response.sort((a, b) => new Date(b.published_at).getTime() - new Date(a.published_at).getTime());

  const html = await eta.render("./index.eta", { data: response, settings: SETTINGS });
  await Deno.writeFile(join(SETTINGS.PUBLIC_PATH, "./index.html"), new TextEncoder().encode(html));
  logger.info(`[cronHandlerFeedBuilder] Feed built in ${Date.now() - now}ms`);
}

/**
 * Main
 */

await Deno.mkdir(SETTINGS.DATA_PATH, { recursive: true });
await Deno.mkdir(SETTINGS.PUBLIC_PATH, { recursive: true });

try {
  await Deno.stat(SETTINGS.SUBSCRIPTIONS_FILE);
} catch (_e) {
  await Deno.writeTextFile(SETTINGS.SUBSCRIPTIONS_FILE, "");
}

const eta = new Eta({ views: "./templates" });
const kv = await Deno.openKv(join(SETTINGS.DATA_PATH, "./kv.store"));

const startedAt = Date.now();

Deno.cron("UPDATE_QUEUE", SETTINGS.CRON_QUEUE_UPDATE, cronHandlerUpdateQueue);
Deno.cron("FEED_BUILDER", SETTINGS.CRON_FEED_BUILDER, cronHandlerFeedBuilder);

/**
 * FIXME: Deno queue doesn't have any concurrency mecanism (yet?).
 * This is bad because if the queue is too big, all task will be executed concurrently
 * and it may cause rate limit or requests bottleneck.
 */
kv.listenQueue(queueHandlerRSSFetcher);

cronHandlerFeedBuilder();
cronHandlerUpdateQueue();

await Deno.serve({ port: SETTINGS.PORT, hostname: "0.0.0.0" }, httpHandler);
