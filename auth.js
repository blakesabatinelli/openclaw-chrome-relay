import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const RELAY_TOKEN_CONTEXT = "openclaw-extension-relay-v1";

/**
 * Derive the relay auth token from the gateway token and port.
 * Same algorithm as the Chrome extension (background-utils.js) and
 * the OpenClaw relay server (extension-relay-auth.ts).
 */
export function deriveRelayToken(gatewayToken, port) {
  return createHmac("sha256", gatewayToken)
    .update(`${RELAY_TOKEN_CONTEXT}:${port}`)
    .digest("hex");
}

/**
 * Load gateway token from openclaw.json config.
 * Falls back to OPENCLAW_GATEWAY_TOKEN env var.
 */
export function loadGatewayToken() {
  const envToken = process.env.OPENCLAW_GATEWAY_TOKEN?.trim();
  if (envToken) return envToken;

  try {
    const configPath = join(
      process.env.OPENCLAW_HOME || join(process.env.HOME || "/root", ".openclaw"),
      "openclaw.json",
    );
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    const token = config?.gateway?.auth?.token;
    if (typeof token === "string" && token.trim()) return token.trim();
  } catch {
    // ignore config read failures
  }

  return null;
}

/**
 * Resolve the set of tokens the relay should accept.
 * Accepts both the derived relay token and the raw gateway token
 * (matches OpenClaw's behavior in extension-relay-auth.ts).
 */
export function resolveAcceptedTokens(gatewayToken, port) {
  const relayToken = deriveRelayToken(gatewayToken, port);
  const tokens = new Set([relayToken]);
  if (relayToken !== gatewayToken) tokens.add(gatewayToken);
  return tokens;
}
