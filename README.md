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

Take a look at the compose file for volumes mount and other options.

https://github.com/yadomi/tube/blob/master/docker-compose.yml

and also the list of env variable:

https://github.com/yadomi/tube/blob/65c407ecdeda765b7356a02d34ccc3c54e121dc1/main.ts#L11-L50

## Without docker

To run the app localy without a docker container:

    deno task dev
