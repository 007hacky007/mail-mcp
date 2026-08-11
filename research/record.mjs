// Usage: node research/record.mjs <probe-name> [args...]
// Runs a probe, redacts the result, prints it, and writes results/<name>.json.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "./harness.mjs";
import { redact } from "./redact.mjs";
import { shapeOf } from "./shape.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(HERE, "results");

const [name, ...args] = process.argv.slice(2);
if (!name) {
  console.error("usage: node research/record.mjs <probe-name> [args...]");
  process.exit(2);
}

const result = runProbe(name, args);
if (!result.ok) {
  console.error(`probe ${name} failed after ${result.seconds.toFixed(2)}s:\n${result.error}`);
  process.exit(1);
}

// redact() throws on an object key it does not recognize (see
// STRUCTURAL_KEY_NAMES in research/redact.mjs) - deliberately, so a probe
// author is told to declare the new field rather than getting a silently
// mangled fingerprint. The whole record is built inside one try so that a
// throw is caught before anything reaches disk: no partial recording, and
// no fallback to writing unredacted data under any circumstances.
let record;
try {
  const redactedArgs = redact(args);
  const redactedData = redact(result.data);
  record = {
    probe: name,
    args: redactedArgs,
    seconds: Number(result.seconds.toFixed(3)),
    // Fingerprint the REDACTED value, never the raw one: a fingerprint
    // contains key names verbatim and is committed to research/results/, so
    // fingerprinting raw data would bypass redaction entirely for any probe
    // that ever uses a data value (an email address, an account or mailbox
    // name) as an object key. shapeOf(redactedData) is what verify.mjs must
    // also compute against a freshly-run probe (see research/verify.mjs) -
    // if one side fingerprints raw and the other redacted, every such probe
    // reports a spurious mismatch the moment the two diverge.
    shape: shapeOf(redactedData),
    data: redactedData,
  };
} catch (err) {
  console.error(
    `probe ${name}: refusing to record - redact() rejected a field in this probe's output.\n${err.message}`
  );
  process.exit(1);
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(resolve(RESULTS, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
