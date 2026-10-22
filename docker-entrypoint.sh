#!/bin/sh
set -eu

# Bind-mounted host directories can override the image's /data ownership.
# Prepare the persisted data files at runtime, then run the app unprivileged.
mkdir -p /data
chown node:node /data
for file in /data/shiit.json /data/shiit.json.tmp /data/shiit.json.v1.bak; do
  if [ -e "$file" ]; then
    chown node:node "$file"
  fi
done

exec su-exec node:node node server.js
