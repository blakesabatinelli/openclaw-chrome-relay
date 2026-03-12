/**
 * MCP stdio server for the chrome-relay.
 *
 * Exposes high-level browser tools over the Model Context Protocol.
 * Each tool maps to an HTTP call to the relay-server.
 *
 * Usage:
 *   RELAY_URL=http://127.0.0.1:18795 RELAY_TOKEN=<token> node mcp-server.js
 *
 * Register in openclaw.json under plugins.entries.acpx.config.mcpServers:
 *   "chrome": {
 *     "command": "node",
 *     "args": ["/root/.openclaw/chrome-relay/mcp-server.js"],
 *     "env": { "RELAY_URL": "http://127.0.0.1:18795", "RELAY_TOKEN": "<token>" }
 *   }
 */
import { createInterface } from "node:readline";
import { deriveRelayToken, loadGatewayToken } from "./auth.js";

const RELAY_URL = (process.env.RELAY_URL || "http://127.0.0.1:18795").replace(/\/$/, "");
const RELAY_PORT = parseInt(new URL(RELAY_URL).port || "18795", 10);

// Resolve token: explicit env var, or derive from gateway token
const RELAY_TOKEN = (() => {
  if (process.env.RELAY_TOKEN?.trim()) return process.env.RELAY_TOKEN.trim();
  const gw = loadGatewayToken();
  if (gw) return deriveRelayToken(gw, RELAY_PORT);
  throw new Error("No RELAY_TOKEN or gateway token available");
})();

// ---------------------------------------------------------------------------
// HTTP client to relay
// ---------------------------------------------------------------------------
async function relayRequest(method, path, body) {
  const url = `${RELAY_URL}${path}`;
  const headers = {
    "x-openclaw-relay-token": RELAY_TOKEN,
    "Content-Type": "application/json",
  };
  const opts = { method, headers };
  if (body !== undefined && method !== "GET") {
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  return await res.json();
}

async function relayGet(path) {
  return relayRequest("GET", path);
}

async function relayPost(path, body) {
  return relayRequest("POST", path, body);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------
const TOOLS = [
  {
    name: "chrome_tabs",
    description: "List Chrome tabs currently attached via the Browser Relay extension. Call this first to see what's available.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    handler: async () => relayGet("/api/tabs"),
  },
  {
    name: "chrome_navigate",
    description: "Navigate an attached Chrome tab to a URL.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "URL to navigate to" },
        targetId: { type: "string", description: "Tab targetId (optional, defaults to most recent tab)" },
      },
      required: ["url"],
    },
    handler: async (args) => relayPost("/api/navigate", args),
  },
  {
    name: "chrome_snapshot",
    description:
      "Get a text representation of the current page. Returns annotated text showing headings, links, buttons, inputs, and visible text. Use this to understand what's on the page before interacting.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Tab targetId (optional)" },
        format: { type: "string", enum: ["text", "html"], description: "Output format (default: text)" },
        maxLength: { type: "number", description: "Max output length (default: 100000)" },
      },
    },
    handler: async (args) => {
      const params = new URLSearchParams();
      if (args.targetId) params.set("targetId", args.targetId);
      if (args.format) params.set("format", args.format);
      if (args.maxLength) params.set("maxLength", String(args.maxLength));
      const qs = params.toString();
      return relayGet(`/api/snapshot${qs ? "?" + qs : ""}`);
    },
  },
  {
    name: "chrome_eval",
    description:
      "Evaluate a JavaScript expression in the page context. Returns the result. Use for advanced operations not covered by other tools.",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "JavaScript expression to evaluate" },
        targetId: { type: "string", description: "Tab targetId (optional)" },
      },
      required: ["expression"],
    },
    handler: async (args) => relayPost("/api/eval", args),
  },
  {
    name: "chrome_click",
    description:
      "Click an element on the page by CSS selector. The element is scrolled into view first. Returns the text of the clicked element.",
    inputSchema: {
      type: "object",
      properties: {
        selector: { type: "string", description: "CSS selector for the element to click" },
        targetId: { type: "string", description: "Tab targetId (optional)" },
        doubleClick: { type: "boolean", description: "Double-click instead of single click" },
      },
      required: ["selector"],
    },
    handler: async (args) => relayPost("/api/click", args),
  },
  {
    name: "chrome_type",
    description:
      "Type text into an input field. Optionally focus a specific element by CSS selector first. Can clear the field and/or press Enter to submit.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "Text to type" },
        selector: { type: "string", description: "CSS selector to focus before typing (optional)" },
        submit: { type: "boolean", description: "Press Enter after typing" },
        clear: { type: "boolean", description: "Clear the field before typing" },
        targetId: { type: "string", description: "Tab targetId (optional)" },
      },
      required: ["text"],
    },
    handler: async (args) => relayPost("/api/type", args),
  },
  {
    name: "chrome_screenshot",
    description: "Capture a PNG screenshot of the page. Returns base64-encoded image data.",
    inputSchema: {
      type: "object",
      properties: {
        targetId: { type: "string", description: "Tab targetId (optional)" },
        fullPage: { type: "boolean", description: "Capture the full scrollable page" },
      },
    },
    handler: async (args) => relayPost("/api/screenshot", args || {}),
  },
];

const toolMap = new Map(TOOLS.map((t) => [t.name, t]));

// ---------------------------------------------------------------------------
// JSON-RPC / MCP protocol over stdio
// ---------------------------------------------------------------------------
let initialized = false;

function send(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write(`Content-Length: ${Buffer.byteLength(json)}\r\n\r\n${json}`);
}

function sendResult(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg) {
  const { id, method, params } = msg;

  if (method === "initialize") {
    initialized = true;
    return sendResult(id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "chrome-relay", version: "0.1.0" },
    });
  }

  if (method === "notifications/initialized") {
    // Client ack — nothing to do
    return;
  }

  if (method === "tools/list") {
    return sendResult(id, {
      tools: TOOLS.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    });
  }

  if (method === "tools/call") {
    const toolName = params?.name;
    const tool = toolMap.get(toolName);
    if (!tool) {
      return sendResult(id, {
        content: [{ type: "text", text: `Unknown tool: ${toolName}` }],
        isError: true,
      });
    }
    try {
      const result = await tool.handler(params?.arguments || {});
      return sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      });
    } catch (err) {
      return sendResult(id, {
        content: [{ type: "text", text: `Error: ${err.message || err}` }],
        isError: true,
      });
    }
  }

  // Ping
  if (method === "ping") {
    return sendResult(id, {});
  }

  if (id !== undefined) {
    sendError(id, -32601, `Method not found: ${method}`);
  }
}

// ---------------------------------------------------------------------------
// Stdio transport: read Content-Length framed JSON-RPC messages
// ---------------------------------------------------------------------------
let buffer = "";

process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const headerEnd = buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) break;
    const headerBlock = buffer.slice(0, headerEnd);
    const match = headerBlock.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      buffer = buffer.slice(headerEnd + 4);
      continue;
    }
    const contentLength = parseInt(match[1], 10);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + contentLength) break;
    const body = buffer.slice(bodyStart, bodyStart + contentLength);
    buffer = buffer.slice(bodyStart + contentLength);
    try {
      const msg = JSON.parse(body);
      handleMessage(msg).catch((err) => {
        console.error("MCP handler error:", err);
        if (msg.id !== undefined) {
          sendError(msg.id, -32603, err.message || String(err));
        }
      });
    } catch (err) {
      console.error("MCP parse error:", err);
    }
  }
});

process.stdin.on("end", () => process.exit(0));
