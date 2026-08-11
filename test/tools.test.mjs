import { test } from "node:test";
import assert from "node:assert/strict";
import { tools } from "../src/tools/index.mjs";

// The registry is what src/index.mjs hands to the MCP layer. Every entry must
// be fully formed or tools/list advertises something tools/call cannot honor.

test("every registered tool is fully formed", () => {
  assert.ok(tools.length >= 1);
  for (const tool of tools) {
    assert.equal(typeof tool.name, "string", `tool name missing`);
    assert.match(tool.name, /^[a-z][a-z0-9-]*$/, `${tool.name}: names are lowercase-kebab`);
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 0, `${tool.name}: empty description`);
    assert.equal(tool.inputSchema.type, "object", `${tool.name}: schema must be an object type`);
    assert.equal(typeof tool.handler, "function", `${tool.name}: handler missing`);
  }
});

test("tool names are unique", () => {
  const names = tools.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
});

test("doctor is registered", () => {
  assert.ok(tools.some((t) => t.name === "doctor"));
});
