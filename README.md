# Tube

![Screenshot of Tube](./screenshot.png)

Tube is a standalone web app that periodically fetches the RSS feeds of selected YouTube channels.
A static `index.html` is created with a chronological view of all the published videos from subscribed channels.
The app doesn't rely on the YouTube API and only uses the RSS feeds of the channels.
The aim is to be simple and straightforward, KISS.

## Docker image

To build the docker and run image localy:

    docker build -t yadomi/tube .
    docker run -it -rm --name tube yadomi/tube

You can also take a look at the compose.example.yml for volumes mount and other options.

https://github.com/yadomi/tube/blob/master/compose.example.yml


## Without docker

To run the app localy without a docker container:

    deno task run

# FAQ

- **Do I need a YouTube API Key ?**
    - No, Tube does not rely on the YouTube API and only uses the RSS feed from the channel page.
- **Do I need a YouTube/Google Account ?**
    - No, since Tube uses public RSS feeds, no Google account is required. This is a nice alternative to building a subscription feed without a Google/YouTube account.
- **Does it support multiple users ?**
    - No, Tube is designed to be very simple. In fact, it doesn't even support any users as there is no concept of users. However, you can run multiple instances of it with different data paths and ports and/or protect them behind a reverse proxy or similar.
- **Where are my subscription stored ?**
    - Each channel id are stored in a single file called `subscription`.
    The default location is in `./data`
