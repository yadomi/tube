FROM denoland/deno:alpine-1.42.4

WORKDIR /src

COPY main.ts ./
COPY index.eta ./
COPY deno.* ./

RUN deno compile --allow-env --allow-read --allow-write --allow-net=www.youtube.com,0.0.0.0 --unstable-kv --unstable-cron --output=tube main.ts
RUN mv tube /usr/local/bin/tube && chmod +x /usr/local/bin/tube
RUN rm -rf /src

WORKDIR /app

CMD ["tube"]
