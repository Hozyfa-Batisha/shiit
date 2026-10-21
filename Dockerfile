FROM node:20-alpine
WORKDIR /app
COPY server.js ./
COPY public ./public
ENV PORT=3000 DATA_FILE=/data/shiit.json TZ=Africa/Cairo
RUN apk add --no-cache tzdata && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 3000
# hit a static file: the API itself needs a name
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3000/ >/dev/null || exit 1
CMD ["node", "server.js"]
