FROM denoland/deno:alpine-2.2.4

WORKDIR /app

COPY main.ts ./
COPY deno.* ./
COPY templates ./templates

RUN deno cache main.ts

CMD ["deno", "task", "run"]
