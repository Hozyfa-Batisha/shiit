# Shiit

Shiit it out of your head. Then do one thing.

A small self-hosted app for catching ideas the second they show up, without losing what you're working on.

## Run it behind Traefik

```bash
cp .env.example .env      # set SHIIT_HOSTNAME and TRAEFIK_NETWORK
mkdir -p config           # data lives here (config/shiit.json)
docker compose up -d --build
```

The compose file carries the Traefik labels (websecure, `letsencrypt` resolver, `Host(${SHIIT_HOSTNAME})`, port 3000) and joins the external network named in `TRAEFIK_NETWORK`. No ports are published.

Without Docker: `node server.js` (Node 18+, no dependencies), then open http://localhost:3000.

## How it works

- **Name, not password.** First visit asks for a name; your list is saved under it. Anyone who types the same name sees the same list, so it's a label, not a lock. Keep the app on your LAN/VPN or put auth in front of it if that matters.
- **Queue (default):** first in, first out. The oldest idea is **Now**. New ideas join the back.
- **Stack:** newest first. New ideas land on top. "Protect focus" drops them under the current top instead, so a fresh thought doesn't steal your task.
- Flipping Queue/Stack reverses the same list. It's saved per name.
- Per item: **Done**, **Now** (do this next), **Later** (far end), **×**.
- **Stuck?** on the Now item: pick the snag (too big / can't start / boring / need something first). You get a nudge, and for most of them you type a smaller first step, which becomes Now while the big one waits right behind it.
- Timer on the Now item: 2, 10 or 25 minutes.
- Done today and day streak.
- `Ctrl+Enter` finishes the Now item.

## Develop

```bash
node --test               # API tests
python3 assets/make_logo.py assets/logo-source.png public   # rebuild logo + icons from your source art
```

## API

All calls except login need the header `X-Shiit-User: <url-encoded name>`.

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/login` | `{ name }` creates or opens a user |
| GET | `/api/state` | list (already in your mode's order), mode, stats |
| POST | `/api/settings` | `{ mode: "queue"\|"stack", protect: bool }` |
| POST | `/api/ideas` | `{ text }` add |
| POST | `/api/ideas/:id/done` | finish |
| POST | `/api/ideas/:id/top` | make it Now |
| POST | `/api/ideas/:id/bury` | send to the far end |
| POST | `/api/ideas/:id/split` | `{ text }` small step takes Now, original waits behind |
| DELETE | `/api/ideas/:id` | delete |
