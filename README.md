# openclaw-chrome-relay

Chrome Relay – the HTTP bridge between the OpenClaw Browser Relay extension and OpenClaw tools.

This service exposes a small, stable HTTP API on the VPS that proxies to a Chrome tab running the OpenClaw Browser Relay extension on your machine. OpenClaw tools (like `chrome_tabs`, `chrome_snapshot`, `chrome_click`, `chrome_type`, `chrome_eval`, and `chrome_screenshot`) talk to this relay instead of talking directly to Chrome.

## Features

- Health check (`GET /`) – returns `OK` when the relay is up
- Authenticated API surface under `/api/*`:
  - `GET  /api/tabs`       – list attached tabs
  - `GET  /api/snapshot`   – text or HTML snapshot of a tab
  - `POST /api/click`      – click by CSS selector
  - `POST /api/type`       – type text into an element / at cursor
  - `POST /api/eval`       – evaluate JavaScript in a tab
  - `GET  /api/screenshot` – PNG screenshot of a tab
  - `GET  /api/debug`      – structured debug info for the relay
- Token-based auth:
  - `RELAY_TOKEN` env var, **or**
  - Derived token from the OpenClaw gateway config via `auth.js`
- Structured JSON logging (one event per line) for:
  - Server startup
  - Extension connect / disconnect
  - HTTP requests and API calls (method, path, status, duration, tabId)

## Requirements

- Node.js 20+
- A VPS reachable from your local machine
- OpenClaw Browser Relay extension installed and configured

## Installation

Clone the repo on your VPS:

```bash
cd /root/projects
git clone https://github.com/blakesabatinelli/openclaw-chrome-relay.git chrome-relay
cd chrome-relay
npm install
```

## Configuration

The relay reads configuration from environment variables:

- `RELAY_HOST`  – host to bind HTTP + WS on (default: `127.0.0.1`)
- `RELAY_PORT`  – port to bind HTTP + WS on (default: `18795`)
- `RELAY_TOKEN` – shared auth token for `/api/*` and the extension

If `RELAY_TOKEN` is **not** set, the relay will fall back to `auth.js` and derive accepted tokens from the OpenClaw gateway config.

All `/api/*` requests must include **one** of:

- Header: `x-openclaw-relay-token: <token>`
- Query:  `?token=<token>`

## Running the relay

On the VPS:

```bash
cd /root/projects/chrome-relay
RELAY_HOST=127.0.0.1 RELAY_PORT=18795 RELAY_TOKEN=your-token npm start
```

This will:

- Start the HTTP server on `RELAY_HOST:RELAY_PORT`
- Expose `GET /` for health
- Expose the authenticated `/api/*` routes
- Start a WebSocket endpoint at `ws://RELAY_HOST:RELAY_PORT/extension`

## Chrome extension wiring

On your local machine:

1. Start an SSH tunnel from your Mac to the VPS:

   ```bash
   ssh -L 18795:127.0.0.1:18795 root@krab.tail4bcc66.ts.net
   ```

2. In Chrome, install the OpenClaw Browser Relay extension and point it at:

   ```
   ws://127.0.0.1:18795/extension?token=<your-token>
   ```

3. Click the extension badge on the tab you want to control so it’s **attached**.

Once attached, OpenClaw tools can see and act on that tab via the relay API.

## API sketch

### Health

```bash
curl http://127.0.0.1:18795/
# -> OK
```

### Tabs

```bash
curl "http://127.0.0.1:18795/api/tabs" \
  -H "x-openclaw-relay-token: $RELAY_TOKEN"
```

### Snapshot (text)

```bash
curl "http://127.0.0.1:18795/api/snapshot?tabId=TARGET_ID&maxLength=5000" \
  -H "x-openclaw-relay-token: $RELAY_TOKEN"
```

### Type into Google

```bash
curl -X POST "http://127.0.0.1:18795/api/type" \
  -H "x-openclaw-relay-token: $RELAY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tabId": "TARGET_ID",
    "selector": "textarea[name=\"q\"]",
    "text": "openclaw chrome relay test",
    "clear": true,
    "submit": true
  }'
```

### Screenshot

```bash
curl "http://127.0.0.1:18795/api/screenshot?tabId=TARGET_ID&fullPage=false" \
  -H "x-openclaw-relay-token: $RELAY_TOKEN" \
  -o screenshot.png
```

## Development

Standard Node.js project:

```bash
npm install
npm test   # (if/when tests are added)
```

Key files:

- `relay-server.js`   – HTTP + WS server, routes, logging
- `auth.js`           – gateway token loading / derivation
- `snapshot.js`       – DOM snapshot JS injected into the page
- `mcp-server.js`     – MCP server integration (used by OpenClaw)
- `IMPLEMENTATION_STEPS.md` – Mini-Agent playbook / roadmap

## License

MIT

