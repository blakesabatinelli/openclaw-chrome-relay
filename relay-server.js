import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { loadGatewayToken, resolveAcceptedTokens } from "./auth.js";
import { SNAPSHOT_JS } from "./snapshot.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RELAY_HOST = process.env.RELAY_HOST || "127.0.0.1";
const RELAY_PORT = parseInt(process.env.RELAY_PORT || "18795", 10);
const RELAY_TOKEN = process.env.RELAY_TOKEN;
const RELAY_VERSION = "0.2.0";
const PING_INTERVAL_MS = 5_000;
const COMMAND_TIMEOUT_MS = 30_000;
const EXTENSION_GRACE_MS = 20_000;
const MAX_BODY_SIZE = 64 * 1024; // 64KB

// Server start time for uptime calculation
const serverStartTime = Date.now();

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
/**
 * Structured logging helper - outputs JSON lines for easy parsing
 * @param {string} event - Event name (e.g., "server.start", "api.request")
 * @param {string} level - Log level: info, warn, error
 * @param {object} data - Additional fields to log
 */
function log(event, level, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event,
    level,
    ...data,
  };
  console.log(JSON.stringify(logEntry));
}

const LOG = {
  info: (event, data) => log(event, "info", data),
  warn: (event, data) => log(event, "warn", data),
  error: (event, data) => log(event, "error", data),
};

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
let acceptedTokens = new Set();

// Support direct RELAY_TOKEN (per roadmap) OR derived tokens from gateway
if (RELAY_TOKEN) {
  // Use RELAY_TOKEN directly (preferred per roadmap)
  acceptedTokens.add(RELAY_TOKEN);
  LOG.info("auth.token", { tokenPrefix: RELAY_TOKEN.slice(0, 8) + "...", source: "env" });
} else {
  // Fall back to gateway token derivation for backward compat
  const gatewayToken = loadGatewayToken();
  if (!gatewayToken) {
    console.error(
      "FATAL: No relay token found. Set RELAY_TOKEN or OPENCLAW_GATEWAY_TOKEN (or configure gateway.auth.token in openclaw.json).",
    );
    process.exit(1);
  }
  acceptedTokens = resolveAcceptedTokens(gatewayToken, RELAY_PORT);
  LOG.info("auth.token", { tokenPrefix: gatewayToken.slice(0, 8) + "...", source: "gateway" });
}

function validateToken(token) {
  return typeof token === "string" && token.trim() && acceptedTokens.has(token.trim());
}

function getTokenFromRequest(req, url) {
  const header = req.headers["x-openclaw-relay-token"]?.trim();
  if (header) return header;
  return url?.searchParams.get("token")?.trim() || null;
}

// ---------------------------------------------------------------------------
// Extension WebSocket state
// ---------------------------------------------------------------------------
/** @type {WebSocket|null} */
let extensionWs = null;
let extensionConnectedSince = null;
let extensionRemoteAddress = null;

/** @type {Map<string, { sessionId: string, targetId: string, targetInfo: object }>} */
const connectedTargets = new Map();

let nextExtensionId = 1;
/** @type {Map<number, { resolve: Function, reject: Function, timer: NodeJS.Timeout }>} */
const pendingCommands = new Map();

let pingTimer = null;
let graceTimer = null;

/** @type {Set<(connected: boolean) => void>} */
const reconnectWaiters = new Set();

function extensionConnected() {
  return extensionWs?.readyState === WebSocket.OPEN;
}

function flushReconnectWaiters(connected) {
  for (const waiter of reconnectWaiters) waiter(connected);
  reconnectWaiters.clear();
}

function clearGraceTimer() {
  if (graceTimer) {
    clearTimeout(graceTimer);
    graceTimer = null;
  }
}

function scheduleGraceCleanup() {
  clearGraceTimer();
  graceTimer = setTimeout(() => {
    graceTimer = null;
    if (!extensionConnected()) {
      connectedTargets.clear();
      flushReconnectWaiters(false);
    }
  }, EXTENSION_GRACE_MS);
}

function waitForExtension(timeoutMs = 3_000) {
  if (extensionConnected()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const waiter = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reconnectWaiters.delete(waiter);
      resolve(connected);
    };
    const timer = setTimeout(() => waiter(false), timeoutMs);
    reconnectWaiters.add(waiter);
  });
}

// ---------------------------------------------------------------------------
// Send CDP command to extension
// ---------------------------------------------------------------------------
function sendToExtension(method, params, sessionId) {
  const ws = extensionWs;
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return Promise.reject(new Error("Extension not connected"));
  }
  const id = nextExtensionId++;
  const payload = {
    id,
    method: "forwardCDPCommand",
    params: { method, params, ...(sessionId ? { sessionId } : {}) },
  };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingCommands.delete(id);
      reject(new Error(`CDP command timeout: ${method}`));
    }, COMMAND_TIMEOUT_MS);
    pendingCommands.set(id, {
      resolve: (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      reject: (e) => {
        clearTimeout(timer);
        reject(e);
      },
      timer,
    });
    try {
      ws.send(JSON.stringify(payload));
    } catch (err) {
      clearTimeout(timer);
      pendingCommands.delete(id);
      reject(err instanceof Error ? err : new Error(String(err)));
    }
  });
}

// ---------------------------------------------------------------------------
// Resolve target
// ---------------------------------------------------------------------------
function resolveSession(targetId) {
  if (targetId) {
    for (const t of connectedTargets.values()) {
      if (t.targetId === targetId) return t.sessionId;
    }
    throw new Error(`No attached tab with targetId: ${targetId}`);
  }
  // Pick most recently attached (last in map iteration order)
  let last = null;
  for (const t of connectedTargets.values()) last = t;
  if (!last) throw new Error("No attached tabs. Click the extension badge on a tab first.");
  return last.sessionId;
}

/**
 * Resolve tabId from API parameter to internal sessionId.
 * Per roadmap: API uses 'tabId', internally we use 'targetId'.
 */
function resolveTab(tabId) {
  // tabId from API maps to internal targetId
  return resolveSession(tabId);
}

// ---------------------------------------------------------------------------
// Handle extension messages
// ---------------------------------------------------------------------------
function onExtensionMessage(data) {
  let msg;
  try {
    msg = JSON.parse(typeof data === "string" ? data : data.toString());
  } catch {
    return;
  }

  // Pong (keepalive response)
  if (msg?.method === "pong") return;

  // Command response
  if (typeof msg?.id === "number" && (msg.result !== undefined || msg.error !== undefined)) {
    const pending = pendingCommands.get(msg.id);
    if (!pending) return;
    pendingCommands.delete(msg.id);
    if (msg.error) pending.reject(new Error(String(msg.error)));
    else pending.resolve(msg.result);
    return;
  }

  // CDP event forwarded from extension
  if (msg?.method === "forwardCDPEvent") {
    const cdpMethod = msg.params?.method;
    const cdpParams = msg.params?.params;

    if (cdpMethod === "Target.attachedToTarget") {
      const { sessionId, targetInfo } = cdpParams || {};
      if (sessionId && targetInfo?.targetId && (targetInfo?.type ?? "page") === "page") {
        connectedTargets.set(sessionId, {
          sessionId,
          targetId: targetInfo.targetId,
          targetInfo,
        });
      }
    } else if (cdpMethod === "Target.detachedFromTarget") {
      const { sessionId, targetId } = cdpParams || {};
      if (sessionId) connectedTargets.delete(sessionId);
      else if (targetId) {
        for (const [sid, t] of connectedTargets) {
          if (t.targetId === targetId) connectedTargets.delete(sid);
        }
      }
    } else if (cdpMethod === "Target.targetInfoChanged") {
      const info = cdpParams?.targetInfo;
      if (info?.targetId) {
        for (const [sid, t] of connectedTargets) {
          if (t.targetId === info.targetId) {
            connectedTargets.set(sid, { ...t, targetInfo: { ...t.targetInfo, ...info } });
          }
        }
      }
    } else if (cdpMethod === "Target.targetDestroyed" || cdpMethod === "Target.targetCrashed") {
      const targetId = cdpParams?.targetId;
      if (targetId) {
        for (const [sid, t] of connectedTargets) {
          if (t.targetId === targetId) connectedTargets.delete(sid);
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function jsonResponse(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function errorResponse(res, status, message) {
  jsonResponse(res, status, { ok: false, error: message });
}

async function readBody(req) {
  const chunks = [];
  let totalSize = 0;
  for await (const chunk of req) {
    totalSize += chunk.length;
    if (totalSize > MAX_BODY_SIZE) {
      throw new Error("Request body too large (max 64KB)");
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Invalid JSON in request body");
  }
}

async function ensureExtension() {
  if (extensionConnected()) return;
  const reconnected = await waitForExtension(3_000);
  if (!reconnected || !extensionConnected()) {
    throw new Error("Extension not connected. Is the browser running with the extension attached?");
  }
}

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------

// GET /api/status — List connected tabs and extension status (internal use)
// Returns: { ok: true, extensionConnected: boolean, tabs: [...] }
async function handleStatus(_req, res) {
  const tabs = [];
  for (const t of connectedTargets.values()) {
    tabs.push({
      id: t.targetId,
      sessionId: t.sessionId,
      targetId: t.targetId,
      title: t.targetInfo?.title || "",
      url: t.targetInfo?.url || "",
    });
  }
  jsonResponse(res, 200, { ok: true, extensionConnected: extensionConnected(), tabs });
}

// GET /api/tabs — List all attached browser tabs
// Returns: { ok: true, tabs: [{ id, sessionId, targetId, title, url }, ...] }
async function handleTabs(_req, res) {
  const tabs = [];
  for (const t of connectedTargets.values()) {
    tabs.push({
      id: t.targetId,
      sessionId: t.sessionId,
      targetId: t.targetId,
      title: t.targetInfo?.title || "",
      url: t.targetInfo?.url || "",
    });
  }
  jsonResponse(res, 200, { ok: true, tabs });
}

// POST /api/navigate — Navigate a tab to a URL
// Body: { url: string, tabId?: string }
// Returns: { ok: true, url, title, ... }
async function handleNavigate(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const url = body.url;
  if (!url || typeof url !== "string") {
    return errorResponse(res, 400, "url is required");
  }
  const sessionId = resolveTab(body.tabId);
  const result = await sendToExtension("Page.navigate", { url }, sessionId);
  // Fetch updated title/url after a short delay
  await new Promise((r) => setTimeout(r, 500));
  let title = "";
  let finalUrl = url;
  try {
    const titleResult = await sendToExtension(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      sessionId,
    );
    title = titleResult?.result?.value || "";
    const urlResult = await sendToExtension(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      sessionId,
    );
    finalUrl = urlResult?.result?.value || url;
  } catch {
    // non-critical
  }
  jsonResponse(res, 200, { ok: true, url: finalUrl, title, ...result });
}

// POST /api/eval — Evaluate JavaScript in a tab
// Body: { expression: string, tabId?: string, returnByValue?: boolean }
// Returns: { ok: true, result, exceptionDetails }
async function handleEval(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const expression = body.expression;
  if (!expression || typeof expression !== "string") {
    return errorResponse(res, 400, "expression is required");
  }
  const sessionId = resolveTab(body.tabId);
  const returnByValue = body.returnByValue !== false;
  const result = await sendToExtension(
    "Runtime.evaluate",
    { expression, returnByValue, awaitPromise: true },
    sessionId,
  );
  jsonResponse(res, 200, {
    ok: true,
    result: result?.result || null,
    exceptionDetails: result?.exceptionDetails || null,
  });
}

// GET /api/snapshot — Get page content (text or HTML)
// Query params: tabId?, format? ("text"|"html"), maxLength? (default 100000)
// Returns text: { ok: true, url, title, snapshot, truncated }
// Returns html: { ok: true, url, title, html, truncated }
async function handleSnapshot(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const tabId = url.searchParams.get("tabId") || undefined;
  const format = url.searchParams.get("format") || "text";
  const maxLength = parseInt(url.searchParams.get("maxLength") || "100000", 10);
  const sessionId = resolveTab(tabId);

  if (format === "html") {
    const result = await sendToExtension(
      "Runtime.evaluate",
      { expression: "document.documentElement.outerHTML", returnByValue: true },
      sessionId,
    );
    let html = result?.result?.value || "";
    const truncated = html.length > maxLength;
    if (truncated) html = html.slice(0, maxLength);
    const titleResult = await sendToExtension(
      "Runtime.evaluate",
      { expression: "document.title", returnByValue: true },
      sessionId,
    );
    const urlResult = await sendToExtension(
      "Runtime.evaluate",
      { expression: "location.href", returnByValue: true },
      sessionId,
    );
    return jsonResponse(res, 200, {
      ok: true,
      url: urlResult?.result?.value || "",
      title: titleResult?.result?.value || "",
      html,
      truncated,
    });
  }

  // Text snapshot: run the DOM walker
  const jsWithMaxLen = `var __maxLength = ${maxLength};\n${SNAPSHOT_JS}`;
  const result = await sendToExtension(
    "Runtime.evaluate",
    { expression: jsWithMaxLen, returnByValue: true, awaitPromise: false },
    sessionId,
  );
  let snapshot = "";
  let truncated = false;
  try {
    const parsed = JSON.parse(result?.result?.value || "{}");
    snapshot = parsed.snapshot || "";
    truncated = parsed.truncated || false;
  } catch {
    snapshot = result?.result?.value || "";
  }
  const titleResult = await sendToExtension(
    "Runtime.evaluate",
    { expression: "document.title", returnByValue: true },
    sessionId,
  );
  const urlResult = await sendToExtension(
    "Runtime.evaluate",
    { expression: "location.href", returnByValue: true },
    sessionId,
  );
  jsonResponse(res, 200, {
    ok: true,
    url: urlResult?.result?.value || "",
    title: titleResult?.result?.value || "",
    snapshot,
    truncated,
  });
}

// POST /api/click — Click an element by CSS selector
// Body: { selector: string, tabId?: string, button?: string, doubleClick?: boolean }
// Returns: { ok: true, clicked: true, elementText, selector }
// Returns error: { ok: false, error: string }
async function handleClick(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const selector = body.selector;
  if (!selector || typeof selector !== "string") {
    return errorResponse(res, 400, "selector is required");
  }
  const sessionId = resolveTab(body.tabId);

  // Find element and get coordinates
  const findJs = `(function() {
    var el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return JSON.stringify({ found: false });
    var rect = el.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    var text = (el.innerText || el.textContent || '').trim().slice(0, 100);
    return JSON.stringify({ found: true, x: x, y: y, text: text });
  })()`;

  const findResult = await sendToExtension(
    "Runtime.evaluate",
    { expression: findJs, returnByValue: true },
    sessionId,
  );
  const elInfo = JSON.parse(findResult?.result?.value || '{"found":false}');
  if (!elInfo.found) {
    return jsonResponse(res, 200, { ok: false, error: `Element not found: ${selector}` });
  }

  const button = body.button || "left";
  const clickCount = body.doubleClick ? 2 : 1;
  const x = Math.round(elInfo.x);
  const y = Math.round(elInfo.y);

  // Scroll element into view first
  await sendToExtension(
    "Runtime.evaluate",
    { expression: `document.querySelector(${JSON.stringify(selector)})?.scrollIntoView({block:'center'})`, returnByValue: true },
    sessionId,
  ).catch(() => {});

  // Re-fetch coordinates after scroll
  const findResult2 = await sendToExtension(
    "Runtime.evaluate",
    { expression: findJs, returnByValue: true },
    sessionId,
  );
  const elInfo2 = JSON.parse(findResult2?.result?.value || '{"found":false}');
  const fx = Math.round(elInfo2.found ? elInfo2.x : elInfo.x);
  const fy = Math.round(elInfo2.found ? elInfo2.y : elInfo.y);

  await sendToExtension(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: fx, y: fy },
    sessionId,
  );
  await sendToExtension(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: fx, y: fy, button, clickCount },
    sessionId,
  );
  await sendToExtension(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: fx, y: fy, button, clickCount },
    sessionId,
  );

  jsonResponse(res, 200, {
    ok: true,
    clicked: true,
    elementText: elInfo2.text || elInfo.text || "",
    selector,
  });
}

// POST /api/type — Type text into an element or at cursor
// Body: { text: string, tabId?: string, selector?: string, clear?: boolean, submit?: boolean }
// Returns: { ok: true, typed: true }
// Returns error: { ok: false, error: string }
async function handleType(req, res) {
  await ensureExtension();
  const body = await readBody(req);
  const text = body.text;
  if (typeof text !== "string") {
    return errorResponse(res, 400, "text is required");
  }
  const sessionId = resolveTab(body.tabId);
  const selector = body.selector;
  const submit = body.submit || false;
  const clear = body.clear || false;

  // Focus element if selector provided
  if (selector) {
    const focusJs = `(function() {
      var el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return JSON.stringify({ found: false });
      el.focus();
      return JSON.stringify({ found: true });
    })()`;
    const focusResult = await sendToExtension(
      "Runtime.evaluate",
      { expression: focusJs, returnByValue: true },
      sessionId,
    );
    const info = JSON.parse(focusResult?.result?.value || '{"found":false}');
    if (!info.found) {
      return jsonResponse(res, 200, { ok: false, error: `Element not found: ${selector}` });
    }
  }

  // Clear field if requested
  if (clear) {
    // Select all + delete
    await sendToExtension(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: "a", code: "KeyA", modifiers: 2 /* Ctrl */ },
      sessionId,
    );
    await sendToExtension(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "a", code: "KeyA", modifiers: 2 },
      sessionId,
    );
    await sendToExtension(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: "Backspace", code: "Backspace" },
      sessionId,
    );
    await sendToExtension(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Backspace", code: "Backspace" },
      sessionId,
    );
  }

  // Type text using insertText (fast, works for most inputs)
  await sendToExtension(
    "Input.insertText",
    { text },
    sessionId,
  );

  // Submit (press Enter) if requested
  if (submit) {
    await sendToExtension(
      "Input.dispatchKeyEvent",
      { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      sessionId,
    );
    await sendToExtension(
      "Input.dispatchKeyEvent",
      { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      sessionId,
    );
  }

  jsonResponse(res, 200, { ok: true, typed: true });
}

// GET /api/screenshot — Capture a screenshot of the tab
// Query params: tabId?, fullPage? ("true"|"false")
// Returns: { ok: true, data: string (base64 PNG), format: "png" }
async function handleScreenshot(req, res) {
  await ensureExtension();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const tabId = url.searchParams.get("tabId") || undefined;
  const fullPage = url.searchParams.get("fullPage") === "true";
  const sessionId = resolveTab(tabId);

  const result = await sendToExtension(
    "Page.captureScreenshot",
    { format: "png", captureBeyondViewport: fullPage },
    sessionId,
  );

  jsonResponse(res, 200, {
    ok: true,
    data: result?.data || "",
    format: "png",
  });
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------
// Track all incoming connections for debug
let totalHttpRequests = 0;
let totalWsUpgradeAttempts = 0;
let lastWsUpgradeAttempt = null;

const server = createServer(async (req, res) => {
  const startTime = Date.now();
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;
  totalHttpRequests++;
  const remote = req.socket.remoteAddress || "unknown";

  // Log every request (except high-frequency ones)
  if (path !== "/extension/status") {
    LOG.info("http.request", { method: req.method, path, remote, origin: req.headers.origin || "none" });
  }

  // Health probe (extension preflight)
  if (req.method === "HEAD" && path === "/") {
    LOG.info("health.probe", { method: "HEAD", remote, status: 200, durationMs: Date.now() - startTime });
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method === "GET" && path === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }

  // CORS for chrome-extension:// origins
  const origin = req.headers.origin;
  if (typeof origin === "string" && origin.startsWith("chrome-extension://")) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": origin || "*",
      "Access-Control-Allow-Methods": "GET, POST, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, x-openclaw-relay-token",
      "Access-Control-Max-Age": "86400",
    });
    res.end();
    return;
  }

  // /extension/status — unauthenticated (used by extension options page)
  if (path === "/extension/status") {
    jsonResponse(res, 200, { connected: extensionConnected() });
    return;
  }

  // /json/version — authenticated, for OpenClaw CLI compat
  if (path === "/json/version" || path === "/json/version/") {
    const token = getTokenFromRequest(req, url);
    if (!validateToken(token)) return errorResponse(res, 401, "Unauthorized");
    const payload = {
      Browser: "OpenClaw/chrome-relay-custom",
      "Protocol-Version": "1.3",
    };
    if (extensionConnected() || connectedTargets.size > 0) {
      payload.webSocketDebuggerUrl = `ws://${RELAY_HOST}:${RELAY_PORT}/cdp`;
    }
    return jsonResponse(res, 200, payload);
  }

  // /json/list — authenticated, for OpenClaw CLI compat
  if (path === "/json" || path === "/json/" || path === "/json/list" || path === "/json/list/") {
    const token = getTokenFromRequest(req, url);
    if (!validateToken(token)) return errorResponse(res, 401, "Unauthorized");
    const list = [];
    for (const t of connectedTargets.values()) {
      list.push({
        id: t.targetId,
        type: t.targetInfo?.type || "page",
        title: t.targetInfo?.title || "",
        url: t.targetInfo?.url || "",
      });
    }
    return jsonResponse(res, 200, list);
  }

  // All /api/* routes require auth
  if (path.startsWith("/api/")) {
    const token = getTokenFromRequest(req, url);
    if (!validateToken(token)) return errorResponse(res, 401, "Unauthorized");

    // Debug endpoint — returns diagnostics per roadmap spec
    if (req.method === "GET" && path === "/api/debug") {
      const tabCount = connectedTargets.size;
      const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
      const durationMs = Date.now() - startTime;
      LOG.info("api.request", { method: "GET", path: "/api/debug", status: 200, durationMs });
      return jsonResponse(res, 200, {
        ok: true,
        version: RELAY_VERSION,
        host: RELAY_HOST,
        port: RELAY_PORT,
        connected: extensionConnected(),
        tabCount,
        uptimeSeconds,
      });
    }

    try {
      let responseSent = false;
      let status = 200;

      // Helper to capture response and log
      const wrapHandler = async (handler, req, res, extraFields = {}) => {
        const handlerStart = Date.now();
        try {
          await handler(req, res);
        } finally {
          const durationMs = Date.now() - handlerStart;
          const tabId = url.searchParams.get("tabId") || req.headers["x-tab-id"] || extraFields.tabId || undefined;
          LOG.info("api.request", {
            method: req.method,
            path,
            status: 200,
            durationMs,
            tabId,
            ...extraFields,
          });
        }
      };

      if (req.method === "GET" && path === "/api/status") {
        return await wrapHandler(handleStatus, req, res);
      }
      if (req.method === "GET" && path === "/api/tabs") {
        return await wrapHandler(handleTabs, req, res);
      }
      if (req.method === "POST" && path === "/api/navigate") {
        // For POST, we need to read body first - handle separately
        const handlerStart = Date.now();
        try {
          await handleNavigate(req, res);
        } finally {
          const durationMs = Date.now() - handlerStart;
          LOG.info("api.request", { method: "POST", path: "/api/navigate", status: 200, durationMs });
        }
        return;
      }
      if (req.method === "POST" && path === "/api/eval") {
        const handlerStart = Date.now();
        try {
          await handleEval(req, res);
        } finally {
          const durationMs = Date.now() - handlerStart;
          LOG.info("api.request", { method: "POST", path: "/api/eval", status: 200, durationMs });
        }
        return;
      }
      if (req.method === "GET" && path === "/api/snapshot") {
        const tabId = url.searchParams.get("tabId");
        const handlerStart = Date.now();
        try {
          await handleSnapshot(req, res);
        } finally {
          const durationMs = Date.now() - handlerStart;
          LOG.info("api.request", { method: "GET", path: "/api/snapshot", status: 200, durationMs, tabId });
        }
        return;
      }
      if (req.method === "POST" && path === "/api/click") {
        const handlerStart = Date.now();
        try {
          await handleClick(req, res);
        } finally {
          const durationMs = Date.now() - handlerStart;
          LOG.info("api.request", { method: "POST", path: "/api/click", status: 200, durationMs });
        }
        return;
      }
      if (req.method === "POST" && path === "/api/type") {
        const handlerStart = Date.now();
        try {
          await handleType(req, res);
        } finally {
          const durationMs = Date.now() - handlerStart;
          LOG.info("api.request", { method: "POST", path: "/api/type", status: 200, durationMs });
        }
        return;
      }
      if ((req.method === "GET" || req.method === "POST") && (path === "/api/screenshot" || path === "/api/screenshot/")) {
        const tabId = url.searchParams.get("tabId");
        const handlerStart = Date.now();
        try {
          await handleScreenshot(req, res);
        } finally {
          const durationMs = Date.now() - handlerStart;
          LOG.info("api.request", { method: req.method, path: "/api/screenshot", status: 200, durationMs, tabId });
        }
        return;
      }
      return errorResponse(res, 404, `Unknown API endpoint: ${path}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      LOG.error("api.error", { path, error: message });
      return errorResponse(res, 500, message);
    }
  }

  errorResponse(res, 404, "Not found");
});

// ---------------------------------------------------------------------------
// WebSocket upgrade
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = url.pathname;
  const remote = req.socket.remoteAddress || "unknown";
  const origin = req.headers.origin || "(none)";

  totalWsUpgradeAttempts++;
  lastWsUpgradeAttempt = new Date().toISOString();

  LOG.info("ws.upgrade", { path: pathname, remote, origin, url: req.url, attempt: totalWsUpgradeAttempts });

  if (pathname !== "/extension") {
    LOG.warn("ws.upgrade.reject", { reason: "wrong_path", expected: "/extension", actual: pathname });
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  // Validate token
  const token = getTokenFromRequest(req, url);
  const tokenSource = req.headers["x-openclaw-relay-token"] ? "header" : url.searchParams.get("token") ? "query" : "none";

  if (!validateToken(token)) {
    LOG.warn("ws.upgrade.reject", { reason: "invalid_token", tokenSource, receivedPrefix: token ? token.slice(0, 8) + "..." : "none" });
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  // Reject if extension already connected
  if (extensionWs && extensionWs.readyState === WebSocket.OPEN) {
    LOG.warn("ws.upgrade.reject", { reason: "already_connected" });
    socket.write("HTTP/1.1 409 Conflict\r\n\r\nExtension already connected");
    socket.destroy();
    return;
  }

  // Clean up stale socket
  if (extensionWs && extensionWs.readyState !== WebSocket.OPEN) {
    LOG.info("ws.upgrade.cleanup", { reason: "stale_socket", readyState: extensionWs.readyState });
    try {
      extensionWs.terminate();
    } catch { /* ignore */ }
    extensionWs = null;
  }

  LOG.info("ws.upgrade.accept", { remote });
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const remote = req?.socket?.remoteAddress || "unknown";
  extensionRemoteAddress = remote;
  extensionConnectedSince = new Date().toISOString();
  LOG.info("extension.connect", { remote, since: extensionConnectedSince });
  extensionWs = ws;
  clearGraceTimer();
  flushReconnectWaiters(true);

  // Start ping interval
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ method: "ping" }));
    }
  }, PING_INTERVAL_MS);

  ws.on("message", (data) => {
    if (extensionWs !== ws) return;
    onExtensionMessage(data);
  });

  ws.on("close", (code, reason) => {
    LOG.info("extension.disconnect", { code: code, reason: reason ? String(reason) : "none" });
    extensionConnectedSince = null;
    extensionRemoteAddress = null;
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (extensionWs !== ws) return;
    extensionWs = null;
    // Reject all pending commands
    for (const [id, pending] of pendingCommands) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Extension disconnected"));
      pendingCommands.delete(id);
    }
    scheduleGraceCleanup();
  });

  ws.on("error", () => {
    // Will trigger close
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
server.listen(RELAY_PORT, RELAY_HOST, () => {
  // Structured log for server startup
  LOG.info("server.start", {
    version: RELAY_VERSION,
    host: RELAY_HOST,
    port: RELAY_PORT,
    wsPath: "/extension",
    httpApiPath: "/api/",
    healthPath: "/",
    acceptedTokenCount: acceptedTokens.size,
  });

  // Human-readable startup output
  console.log(`\n========================================`);
  console.log(`chrome-relay v${RELAY_VERSION}`);
  console.log(`========================================`);
  console.log(`Listening:     ${RELAY_HOST}:${RELAY_PORT}`);
  console.log(`Extension WS:  ws://${RELAY_HOST}:${RELAY_PORT}/extension`);
  console.log(`HTTP API:      http://${RELAY_HOST}:${RELAY_PORT}/api/`);
  console.log(`Health probe:  http://${RELAY_HOST}:${RELAY_PORT}/ (HEAD or GET)`);
  console.log(`Accepted tokens: ${acceptedTokens.size}`);
  console.log(`========================================`);
  console.log(`\nThe extension will:`);
  console.log(`  1. HEAD http://127.0.0.1:${RELAY_PORT}/  (preflight)`);
  console.log(`  2. WS   ws://127.0.0.1:${RELAY_PORT}/extension?token=<hmac>  (connect)`);
  console.log(`\nWaiting for extension connection...\n`);
});
