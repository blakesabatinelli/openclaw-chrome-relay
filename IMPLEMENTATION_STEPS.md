# Chrome Relay – Implementation Steps (Mini-Agent Playbook)

This file breaks the roadmap into **small, sequential tasks** for Mini-Agent.

## Rules

- Work ONLY in `/root/projects/chrome-relay`.
- After each task, **stop** – do not skip ahead.
- Prefer small, incremental changes; avoid giant rewrites.
- When appropriate, run `npm install` once and then `npm start` / `npm test` as smoke checks.
- Always describe which files you changed and why in your final message.

---

## Task 1 – Env-based config & safe defaults

**Goals:**
- Add env-based configuration for host/port/token.
- Keep behavior compatible with the existing relay.

**Concrete steps:**
1. In `relay-server.js`, introduce config values:
   - `RELAY_HOST` (default: `127.0.0.1`)
   - `RELAY_PORT` (default: `18795`)
   - `RELAY_TOKEN` (required for /api/*, but keep auth.js compatibility for now)
2. Wire these into the HTTP server `listen()` call.
3. For now, keep using `auth.js` for token resolution, but:
   - If `RELAY_TOKEN` is set, treat it as the sole accepted token.
   - Otherwise, fall back to the existing `loadGatewayToken` / `resolveAcceptedTokens` logic.
4. Do **not** change any routes yet.
5. Run a basic smoke test:
   - `npm install` (if not already done).
   - `npm start` in one shell, then in another: `curl http://127.0.0.1:<port>/` → should return `OK`.
6. Report:
   - Effective host/port.
   - Whether `/` responded correctly.
   - A brief summary of code changes.

---

## Task 2 – Normalize HTTP API surface

**Goals:**
- Bring the HTTP routes in line with the roadmap spec, while keeping behavior as close to current as possible.

**Required API shape:**
- `GET /` → health (`"OK"`).
- `GET /api/tabs` → list of attached tabs.
- `GET /api/snapshot?tabId=&maxLength=` → page snapshot.
- `POST /api/click` → click by selector.
- `POST /api/type` → type text.
- `POST /api/eval` → evaluate JS.
- `GET /api/screenshot?tabId=&fullPage=` → PNG screenshot.

**Concrete steps:**
1. Read existing route handlers in `relay-server.js`.
2. Adjust handlers so that **public API parameters** use `tabId` instead of `targetId`, but keep internal behavior the same.
3. Change screenshot endpoint from POST to **GET `/api/screenshot`** with query params.
4. Ensure all `/api/*` endpoints:
   - Require `x-openclaw-relay-token`.
   - Return consistent JSON shapes on success and error.
5. Add or update inline comments documenting each route.
6. Smoke test:
   - With the relay running, call each route with dummy/tab-less inputs and verify responses (even if they return empty lists or clear error messages).
7. Report:
   - Route list and expected parameters.
   - Any behavior differences vs the original implementation.

---

## Task 3 – `/api/debug` endpoint

**Goals:**
- Add a simple diagnostics endpoint for the plugin/user.

**Concrete steps:**
1. Implement `GET /api/debug` in `relay-server.js` that returns JSON like:
   ```json
   {
     "ok": true,
     "version": "0.1.0",
     "host": "127.0.0.1",
     "port": 18795,
     "connected": true/false,
     "tabCount": <number>,
     "uptimeSeconds": <number>
   }
   ```
2. If the relay already has a debug endpoint like `/api/debug-sockets`, either:
   - keep it for backwards compat, or
   - have `/api/debug` wrap/simplify the same information.
3. Add minimal logging for debug requests.
4. Smoke test:
   - Hit `GET /api/debug` and verify the JSON structure.
5. Report:
   - Example `GET /api/debug` output.

---

## Task 4 – Structured logging

**Goals:**
- Add simple, structured logs for key events.

**Concrete steps:**
1. Introduce a tiny logging helper in `relay-server.js` (or a new `logger.js`):
   - Functions like `logInfo(event, data)`, `logError(event, data)` that print JSON lines.
2. Add logs for:
   - Server startup (host/port).
   - Extension connect/disconnect.
   - Each `/api/*` request (route, tabId, status, duration).
3. Keep logging lightweight and human-readable; no external deps.
4. Smoke test:
   - Start the relay and hit a couple of APIs, confirm logs look sane.
5. Report:
   - Example log lines for a tab listing and a snapshot call.

---

## Task 5 – CLI entrypoint

**Goals:**
- Make it easy to start the relay via a single command.

**Concrete steps:**
1. Update `package.json`:
   - Ensure there is a `"start": "node relay-server.js"` script.
   - Add a `"bin"` entry for a `chrome-relay` command that runs `relay-server.js`.
2. If needed, create a small `bin/chrome-relay.js` wrapper that:
   - loads env,
   - starts the server.
3. Smoke test:
   - `npm install` (if needed).
   - `npm start` and/or `npx chrome-relay`.
4. Report:
   - Exact commands to run the relay.

---

## Task 6 – Sanity test with OpenClaw (optional, later)

**Goals:**
- Verify the new relay works end-to-end with OpenClaw’s chrome-relay plugin.

**Concrete steps (to be run only when explicitly asked):**
1. Ensure OpenClaw plugin config points to the new relay URL/token.
2. Start the new relay.
3. From OpenClaw, call `chrome_tabs` / `chrome_snapshot`.
4. Confirm behavior matches the old relay.
5. Report:
   - Any differences or issues observed.

Do **not** execute Task 6 unless explicitly requested.
