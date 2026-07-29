# syntax=docker/dockerfile:1.7

ARG DENO_VERSION=2.9.4
FROM denoland/deno:alpine-${DENO_VERSION}

ARG REPOSITORY

LABEL org.opencontainers.image.title="Wish Deno" \
      org.opencontainers.image.description="Self-hosted, privacy-conscious wish lists" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.source="https://github.com/${REPOSITORY}"

WORKDIR /app

USER root
COPY --chown=deno:deno deno.json ./
COPY --chown=deno:deno src ./src
COPY --chown=deno:deno public ./public
RUN deno cache src/main.ts \
    && mkdir -p /data \
    && chown deno:deno /data

ENV HOST=0.0.0.0 \
    PORT=8000 \
    DATABASE_PATH=/data/wish-deno.sqlite \
    PUBLIC_DIR=/app/public \
    COOKIE_SECURE=true \
    DENO_NO_UPDATE_CHECK=1 \
    NO_COLOR=1

USER deno

VOLUME ["/data"]
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["deno", "eval", "const p=Deno.env.get('PORT')??'8000';const r=await fetch(`http://127.0.0.1:${p}/health`);if(!r.ok)Deno.exit(1)"]

CMD ["task", "start"]
