# Ticket Tracker Bot

Telegram bot for tracking public `eticket.railway.uz` train availability and messaging users when matching tickets appear.

This version is built for Cloudflare Workers + D1 so it can run on Cloudflare's free tier for small usage. It does not log in, choose seats, or hold tickets; it watches the same public train results shown before the login/seat-selection flow.

## Bot Flow

Users can run `/start`, then `/newtracker` and answer:

1. From station, for example `Tashkent`
2. To station, for example `Samarkand`
3. One or more dates, for example `2026-08-18`, `2026-08-18, 2026-08-20`, or `2026-08-18..2026-08-21`
4. One or more ticket types, for example `O'rindiqli,Kupe`, `Kupe,Plaskartli,SV`, or `any`

Commands:

```text
/start
/newtracker
/track FROM -> TO [DATE] [days=N] [dates=D1,D2] [types=TYPE1,TYPE2]
/list
/stop ID
/stop_all
/stations QUERY
/types
/cancel
```

Examples:

```text
/track Tashkent -> Samarkand 2026-08-18 days=3 types=Kupe,SV
/track Toshkent -> Buxoro dates=2026-08-18,2026-08-20 types=O'rindiqli,Kupe
/track 2900000 -> 2900700 tomorrow types=Сидячий
```

Type aliases work across common labels:

```text
O'rindiqli / Сидячий / seated
Kupe / Купе / coupe
Plaskartli / Плацкартный / platskart
SV / СВ
```

## Deploy To Cloudflare

Install dependencies locally:

```bash
npm install
```

Log in to Cloudflare:

```bash
npx wrangler login
```

Create the D1 database:

```bash
npx wrangler d1 create tickettracker
```

Copy the returned `database_id` into `wrangler.toml`, replacing `REPLACE_WITH_D1_DATABASE_ID`.

Create the tables:

```bash
npx wrangler d1 execute tickettracker --remote --file=schema.sql
```

Set secrets. Use the Telegram token you already created, but do not commit it:

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put WEBHOOK_SECRET
npx wrangler secret put ADMIN_SECRET
```

Deploy:

```bash
npx wrangler deploy
```

Set the Telegram webhook. Replace the values with your deployed Worker URL and `ADMIN_SECRET`:

```bash
WORKER_URL="https://tickettracker.<your-subdomain>.workers.dev" \
ADMIN_SECRET="your-admin-secret" \
curl -X POST "$WORKER_URL/setup-webhook?secret=$ADMIN_SECRET"
```

After that, open Telegram and send `/start` to the bot.

## Local Checks

```bash
npm run check
```

## Free-Tier Notes

The cron is configured to run every minute. `CHECK_LIMIT` defaults to 20 trackers per cron run to keep subrequests bounded. For a small private bot this should remain comfortably inside Cloudflare's free limits.
