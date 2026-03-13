# Stage 1: Build the Deno binary
FROM denoland/deno:alpine-1.42.4 AS builder

WORKDIR /app

COPY tube.ts ./

RUN deno compile --allow-write --allow-read --allow-net --output /app/tube tube.ts
