FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY docker-entrypoint.sh ./
COPY public ./public
ENV PORT=3050 DATA_FILE=/data/shiit.json TZ=Africa/Cairo
RUN apk add --no-cache tzdata su-exec && mkdir -p /data && chown node:node /data && chmod +x ./docker-entrypoint.sh
VOLUME /data
EXPOSE 3050
# hit a static file: the API itself needs a name
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:${PORT}/ >/dev/null || exit 1
ENTRYPOINT ["./docker-entrypoint.sh"]
