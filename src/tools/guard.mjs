/**
 * Hand-written input guards, one call per tool handler. The JSON Schema in
 * each tool's inputSchema is advertisement for the host; this is enforcement.
 */
export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = "InputError";
  }
}

/**
 * @param {object} args   the tools/call arguments object
 * @param {Record<string, "string"|"boolean"|"number"|"string[]">} allowed
 *   allowed keys and their required types; every key is optional here, and
 *   cross-field requirements stay in the tool where they are legible.
 */
export function guardArgs(args, allowed) {
  for (const key of Object.keys(args)) {
    if (!(key in allowed)) {
      const known = Object.keys(allowed).join(", ") || "none";
      throw new InputError(`Unknown argument "${key}". Allowed arguments: ${known}.`);
    }
    const value = args[key];
    if (value === undefined || value === null) continue;
    const want = allowed[key];
    if (want === "string[]") {
      const ok = Array.isArray(value) && value.every((v) => typeof v === "string");
      if (!ok) throw new InputError(`Argument "${key}" must be an array of strings.`);
      continue;
    }
    const actual = Array.isArray(value) ? "array" : typeof value;
    if (actual !== want) {
      throw new InputError(`Argument "${key}" must be a ${want}, got ${actual}.`);
    }
  }
}
