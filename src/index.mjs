#!/usr/bin/env node
/**
 * Entry point. Wires the MCP stdio layer to the tool registry and fires the
 * warm-up probe once the host says it is ready, so the first Apple Event of
 * Mail's process lifetime is paid at startup rather than inside a user's
 * first real request.
 */
import { createServer, log } from "./mcp/server.mjs";
import { warmUp } from "./jxa/runner.mjs";
import { tools, SERVER_NAME, SERVER_VERSION } from "./tools/index.mjs";

createServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
  tools,
  onReady: () => {
    // Fire and forget: warm-up must never delay or fail the handshake.
    // warmUp() swallows its own errors; a real call will report any problem.
    warmUp().then(() => log("warm-up complete"));
  },
}).start();

log(`${SERVER_NAME} ${SERVER_VERSION} on stdio, ${tools.length} tool(s)`);
