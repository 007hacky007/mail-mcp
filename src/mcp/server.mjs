/**
 * Minimal MCP server over stdio. Newline-delimited JSON-RPC 2.0.
 *
 * This layer knows nothing about mail. It is deliberately small because it is
 * the only place that parses input from the host.
 *
 * stdout carries JSON-RPC and nothing else. Every diagnostic goes to stderr.
 */
import { createInterface } from "node:readline";

const JSONRPC = "2.0";

// JSON-RPC 2.0 reserved codes.
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

export function log(...parts) {
  process.stderr.write(`[mail-mcp] ${parts.join(" ")}\n`);
}

/**
 * @param {{
 *   name: string,
 *   version: string,
 *   tools: Array<{name: string, description: string, inputSchema: object, handler: Function}>,
 *   onReady?: () => void | Promise<void>
 * }} config
 */
export function createServer(config) {
  const tools = new Map(config.tools.map((t) => [t.name, t]));

  function send(message) {
    process.stdout.write(JSON.stringify(message) + "\n");
  }

  function sendResult(id, result) {
    send({ jsonrpc: JSONRPC, id, result });
  }

  function sendError(id, code, message, data) {
    const error = { code, message };
    if (data !== undefined) error.data = data;
    send({ jsonrpc: JSONRPC, id, error });
  }

  async function handleInitialize(id, params) {
    // Echo the client's protocol version rather than pinning one: this server
    // uses only the long-stable core of the protocol, and pinning a version
    // would break against hosts newer than this file.
    const requested = typeof params?.protocolVersion === "string" ? params.protocolVersion : null;
    sendResult(id, {
      protocolVersion: requested ?? "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: config.name, version: config.version },
    });
  }

  function handleToolsList(id) {
    sendResult(id, {
      tools: [...tools.values()].map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      })),
    });
  }

  async function handleToolsCall(id, params) {
    const name = params?.name;
    if (typeof name !== "string") {
      sendError(id, INVALID_PARAMS, "tools/call requires a string 'name'.");
      return;
    }
    const tool = tools.get(name);
    if (!tool) {
      sendError(id, INVALID_PARAMS, `Unknown tool: ${name}`);
      return;
    }
    const args = params.arguments ?? {};
    if (typeof args !== "object" || Array.isArray(args) || args === null) {
      sendError(id, INVALID_PARAMS, `Tool arguments must be an object.`);
      return;
    }

    try {
      const value = await tool.handler(args);
      sendResult(id, {
        content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
      });
    } catch (err) {
      // A tool failure is a tool-level error, not a protocol error: the model
      // needs to see it and adapt. Protocol errors are for malformed requests.
      const message = err instanceof Error ? err.message : String(err);
      log(`tool ${name} failed:`, message);
      sendResult(id, {
        content: [{ type: "text", text: `Error: ${message}` }],
        isError: true,
      });
    }
  }

  async function dispatch(message) {
    const { id, method, params } = message;
    const isNotification = id === undefined || id === null;

    switch (method) {
      case "initialize":
        if (!isNotification) await handleInitialize(id, params);
        return;
      case "notifications/initialized":
      case "initialized":
        if (config.onReady) await config.onReady();
        return;
      case "tools/list":
        if (!isNotification) handleToolsList(id);
        return;
      case "tools/call":
        if (!isNotification) await handleToolsCall(id, params);
        return;
      case "ping":
        if (!isNotification) sendResult(id, {});
        return;
      default:
        if (!isNotification) sendError(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
        return;
    }
  }

  function start() {
    const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

    rl.on("line", (line) => {
      const text = line.trim();
      if (!text) return;

      let message;
      try {
        message = JSON.parse(text);
      } catch {
        sendError(null, PARSE_ERROR, "Invalid JSON.");
        return;
      }
      if (typeof message !== "object" || message === null || typeof message.method !== "string") {
        sendError(message?.id ?? null, INVALID_REQUEST, "Not a JSON-RPC request.");
        return;
      }

      // Requests are handled in arrival order. Mail calls serialize inside the
      // JXA runner regardless, so there is nothing to gain from overlapping.
      dispatch(message).catch((err) => {
        const detail = err instanceof Error ? err.message : String(err);
        log("dispatch failed:", detail);
        if (message.id !== undefined && message.id !== null) {
          sendError(message.id, INTERNAL_ERROR, detail);
        }
      });
    });

    // Host closed stdin: shut down rather than linger holding resources.
    rl.on("close", () => process.exit(0));
    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => process.exit(0));
    }
  }

  return { start };
}
