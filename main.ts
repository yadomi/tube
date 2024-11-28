import { parse } from "https://deno.land/x/xml@5.4.16/mod.ts";
import { Eta } from "https://deno.land/x/eta@v3.5.0/src/index.ts";
import Logger from "https://deno.land/x/logger@v1.1.7/logger.ts";
import { DOMParser } from "https://deno.land/x/deno_dom@v0.1.48/deno-dom-wasm.ts";
import { join } from "https://deno.land/std@0.224.0/path/mod.ts";

const UA = "curl/7.64.1";
const logger = new Logger();
const startedAt = Date.now();

const DATA_PATH = Deno.env.get("TUBE_DATA_PATH") || "./data";

const SETTINGS = {
  PORT: Number(Deno.env.get("TUBE_PORT")) || 8888,

  /**
   * Path to store internal data
   */
  DATA_PATH,
  SUBSCRIPTIONS_FILE: join(DATA_PATH, "subscriptions"),

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
   * If true, will allow shorts to be visible in the feed.
   */
  ALLOW_SHORTS: !!JSON.parse(Deno.env.get("TUBE_ALLOW_SHORTS") || "false"),

  /**
   * The URL used as link on each video. The id of the vido is added at the end.
   * Can be used to use the embed (fullscreen-ish) link or a different youtube frontend such as invidious
   */
  YOUTUBE_FRONTEND: Deno.env.get("TUBE_YOUTUBE_FRONTEND") || "https://www.youtube.com/watch?v=",

  /**
   * A gotify endpoint URL to send a notification on new video.
   * See: https://gotify.net/
   */
  GOTIFY_URL: Deno.env.get("TUBE_GOTIFY_URL") || false,

  /**
   * Used to format date and time to the specified locale (eg: en or fr-FR ect...)
   * See: https://en.wikipedia.org/wiki/IETF_language_tag
   */
  LOCALE: Deno.env.get('TUBE_LOCALE'),
} as const;

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
};

const ResponseHeaders = {
  headers: {
    ...Cors,
  },
};

const HTTPResponse = {
  OK(req) {
    const referer = req.headers.get('referer')
    if (!referer) {
      return new Response("OK", { status: 200, ...ResponseHeaders })
    }

    const headers = new Headers({
      location: new URL(referer),
    });
    
    return new Response(null, {
      status: 302,
      headers,
    });
  },
  ALREADY_EXISTS: new Response("ALREADY_EXISTS", { status: 409, ...ResponseHeaders }),
  BAD_REQUEST: (reason: string) => new Response("Bad Request: " + reason, { status: 400, ...ResponseHeaders }),
  NOT_FOUND: new Response("Not Found", { status: 404, ...ResponseHeaders }),
  METHOD_NOT_ALLOWED: new Response("Method Not Allowed", { status: 405, ...ResponseHeaders }),
  INTERNAL_SERVER_ERROR: new Response("Internal Server Error", { status: 500, ...ResponseHeaders }),
};

enum PostMethod {
  AddByURL = "add_by_url",
  DeleteById = "delete_by_id",
  SetNotifyState = "set_notify_state",
}

const Manager = {
  async add_by_id(id: string): Promise<Response> {
    const channels = await Helpers.get_channels();

    if (channels.indexOf(id) !== -1) {
      throw HTTPResponse.ALREADY_EXISTS;
    }

    await Deno.writeTextFile(SETTINGS.SUBSCRIPTIONS_FILE, `\n${id}`, {
      append: true,
    });

    await Helpers.enqueue(id, 0);
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
      throw HTTPResponse.BAD_REQUEST("URL of a video is not supported yet");
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

      throw HTTPResponse.NOT_FOUND;
    }

    throw HTTPResponse.BAD_REQUEST("Invalid URL");
  },
};

const postHandler = async (req: Request) => {
  const params = new URL(req.url).searchParams;
  const body = await req.text();
  const data = new URLSearchParams(body);

  switch (params.get("method")) {
    case PostMethod.AddByURL: {
      const url = data.get('url');

      if (!url) {
        return HTTPResponse.BAD_REQUEST("url is required");
      }

      try {
        await Manager.add_by_url(url);
        return HTTPResponse.OK(req);
      } catch (error) {
        if (error instanceof Response) {
          return error;
        }
        return HTTPResponse.INTERNAL_SERVER_ERROR;
      }
    }
    case PostMethod.DeleteById: {
      const id = data.get("channel_id");
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

      return HTTPResponse.OK(req);
    }
    case PostMethod.SetNotifyState: {
      const id = data.get("channel_id");

      if (!id) {
        return HTTPResponse.BAD_REQUEST("channel_id is required");
      }

      const value = data.get("value") === "on";
      await kv.set(["notify", id], value);

      return HTTPResponse.OK(req);
    }
  }

  return HTTPResponse.METHOD_NOT_ALLOWED;
};

const getHandler = async (req: Request) => {
  switch (new URL(req.url).pathname) {
    case "/": {
      const params = new URL(req.url).searchParams;
      if (params.get('force')) {
        cronHandlerFeedBuilder();
      }

      const html = await Deno.open(join(SETTINGS.PUBLIC_PATH, "index.html"));
      return new Response(html.readable, { status: 200 });
    }
    case "/manage": {
      const channels = await Helpers.get_channels();
      const data: { id: string; title: string; last_at: string; notify: boolean }[] = [];

      for (const channel_id of channels) {
        const notify = !!(await kv.get(["notify", channel_id])).value;

        try {
          const rss = JSON.parse(await Deno.readTextFile(`./data/${channel_id}.json`)) as Feed;
          data.push({
            id: channel_id,
            title: rss.feed.title,
            last_at: Array.isArray(rss.feed.entry) ? rss.feed.entry[0].published : rss.feed.entry.published,
            notify,
          });
        } catch (_e) {
          data.push({
            id: channel_id,
            title: "N/A (not fetched yet)",
            last_at: new Date(0).toISOString(),
            notify,
          });
        }
      }

      data.sort((a, b) => new Date(b.last_at).getTime() - new Date(a.last_at).getTime());

      const html = await eta.render("./manage.eta", { data, settings: SETTINGS });
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

      // check if we should notify
      const notify = await kv.get(["notify", channel_id]);
      if (notify.value) {
        await asyncTaskKV.enqueue({ type: QueueType.NOTIFY, video });
      }
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

// Global kv store
const kv = await Deno.openKv(join(SETTINGS.DATA_PATH, "./kv.store"));

// KV queue async task
const asyncTaskKV = await Deno.openKv(join(SETTINGS.DATA_PATH, "./kvqueue.store"));

Deno.cron("UPDATE_QUEUE", SETTINGS.CRON_QUEUE_UPDATE, cronHandlerUpdateQueue);
Deno.cron("FEED_BUILDER", SETTINGS.CRON_FEED_BUILDER, cronHandlerFeedBuilder);

/**
 * FIXME: Deno queue doesn't have any concurrency mecanism (yet?).
 * This is bad because if the queue is too big, all task will be executed concurrently
 * and it may cause rate limit or requests bottleneck.
 */
kv.listenQueue(queueHandlerRSSFetcher);

enum QueueType {
  NOTIFY = "notify",
}

asyncTaskKV.listenQueue(async ({ type, ...args }) => {
  switch (type) {
    case QueueType.NOTIFY: {
      if (!SETTINGS.GOTIFY_URL) {
        logger.warn(`[asyncTaskKV.Notify] Gotify URL is not set, skipping notification`);
        return
      }

      const video: FeedEntry = args.video;
      await fetch(SETTINGS.GOTIFY_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message: video.author.name,
          priority: 2,
          title: video.title,
          extras: {
            "client::notification": {
              bigImageUrl: video["media:group"]["media:thumbnail"]["@url"],
              click: {
                url: video.link["@href"],
              },
            },
          },
        }),
      });

      logger.info(`[asyncTaskKV.Notify] Sent notification for "${video.title}" (${video.author.name})`);
      return;
    }
    default:
      break;
  }
});

cronHandlerFeedBuilder();
cronHandlerUpdateQueue();

await Deno.serve({ port: SETTINGS.PORT, hostname: "0.0.0.0" }, httpHandler);
