FROM denoland/deno:alpine-1.42.4

WORKDIR /app

COPY main.ts ./
COPY deno.* ./
COPY templates ./templates

RUN deno cache main.ts

CMD ["deno", "task", "run"]
