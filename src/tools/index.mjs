/**
 * The tool registry: everything src/index.mjs hands to the MCP layer.
 * One import per tool file; nothing here contains logic.
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createDoctorTool } from "./doctor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(HERE, "..", "..", "package.json"), "utf8"));

export const SERVER_NAME = "mail-mcp";
export const SERVER_VERSION = pkg.version;

export const tools = [createDoctorTool({ serverVersion: SERVER_VERSION })];
