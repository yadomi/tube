import * as yaml from "jsr:@std/yaml";
import * as xml from "jsr:@std/xml";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:148.0) Gecko/20100101 Firefox/148.0";
const regex = /https:\/\/(?:www\.)?youtube\.com\/channel\/(?<id>[a-zA-Z0-9_-]+)/g;

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const util = {
  sort(entry: { published: Date }[]) {
    return entry.sort((a, b) => b.published - a.published);
  },
  short(entry: { href: string }) {
    return entry.href.includes("/shorts/");
  },
};

async function crawl() {
  const now = new Date().getTime();
  const text = await Deno.readTextFile("./tubefile.yml");
  const data = yaml.parse(text) as TubeFile;
  const files = [];

  for await (const file of await Deno.readDir("./cache")) {
    if (file.isFile && file.name.endsWith(".xml")) {
      files.push(file);
    }
  }

  for (const channel of data.channels) {
    let res: Response | undefined;
    let html: string | undefined;

    const match = regex.test(channel);

    const id = await (async () => {
      if (match) {
        return regex.exec(channel)?.groups?.id;
      }

      try {
        res = await fetch(channel, {
          headers: {
            "User-Agent": UA,
          },
        });
        html = await res.text();
      } catch (error) {
        console.error(`Failed to page for ${channel}: ${error}`);
        return undefined;
      }

      if (!res || !html) return undefined;
      return regex.exec(html)?.groups.id;
    })();

    if (!id) {
      console.error(`Failed to extract channel ID for ${channel}, skipping...`);
      continue;
    }

    const file = files.find((file) => file.name.startsWith(id));
    if (file) {
      const createdAt = file.name.split("--")[1].split(".")[0];

      if (now - Number(createdAt) < 5 * 60 * 1000) {
        console.log(`Feed for ${channel} is up to date, skipping...`);
        continue;
      }
    }

    const xml = `https://www.youtube.com/feeds/videos.xml?channel_id=${id}`;

    try {
      res = await fetch(xml, {
        headers: {
          "User-Agent": UA,
        },
      });

      html = await res.text();
      const filename = `./cache/${id}--${now}.xml`;
      await Deno.writeTextFile(filename, html);

      for (const file of files) {
        if (file.name.startsWith(id)) {
          await Deno.remove("./cache/" + file.name);
          console.log(`Removed old cached feed file ${file.name}`);
        }
      }
    } catch (error) {
      console.error(error);
      continue;
    }

    await sleep(1000);
  }
}

async function build() {
  const feeds = [];

  const entries = [];
  for await (const file of await Deno.readDir(".")) {
    if (file.isFile && file.name.endsWith(".xml")) {
      const text = await Deno.readTextFile(file.name);
      const data = xml.parse(text) as any;

      for (const node of data.root.children) {
        if (node.type === "element" && node.name.local === "entry") {
          const entry = {};
          for (const property of node.children) {
            if (!property.name) continue;

            if (property.name.local === "link") {
              entry.href = property.attributes.href;
              continue;
            }

            const name = property.name.local;
            if (["videoId", "channelId", "title"].includes(name) && property.children[0]) {
              entry[property.name.local] = property.children[0].text;
              continue;
            }
            if (["published", "updated"].includes(name) && property.children[0]) {
              entry[property.name.local] = new Date(property.children[0].text);
              continue;
            }

            if (name == "author" && property.children[0]) {
              entry.author = property.children.find((child) => child.name && child.name.local === "name")?.children[0].text;
            }
          }
          entries.push(entry);
        }
      }
      continue;
    }
  }
  const sorted = util.sort(entries).filter((entry) => !util.short(entry));

  const index = sorted
    .reduce((acc, entry) => {
      return acc + template.entry(entry);
    }, template.start)
    .concat(template.end);

  await Deno.writeTextFile("./public/index.html", index);
}

const template = {
  start: `<!DOCTYPE html>
      <html lang="fr">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Tube</title>
        </head>
        <body>
        <ul>`,
  end: `</ul></body></html>`,
  entry({ title, href, author, published }: { title: string; href: string; author: string; published: Date }) {
    return `<li><span>${published.toLocaleString("fr", { year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span> - <a target="_blank" href="${href}">${title} - <span>${author}</span></a></li>`;
  },
};

async function main() {
  await crawl();
  await build();
}

main();
