// Usage: node research/record.mjs <probe-name> [args...]
// Runs a probe, redacts the result, prints it, and writes results/<name>.json.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "./harness.mjs";
import { redact } from "./redact.mjs";
import { shapeOf } from "./shape.mjs";
import { requireStorableArgs } from "./argStorability.mjs";
import { collectSuccessProfile, SuccessProfileCollisionError } from "./successProfile.mjs";

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

// Fix round 1 (task-5-review): PROBE ARGUMENTS are replayed VERBATIM by
// research/verify.mjs (`runProbe(recorded.probe, recorded.args ?? [])`), not
// re-derived - reproducibility is the entire point of recording them, so an
// argument cannot go through the same lossy redaction as a probe's output
// `data` (which is only ever read, never re-executed). `requireStorableArgs`
// (research/argStorability.mjs) stores an argument verbatim only when it is
// PROVABLY non-personal for its POSITION (fix round 2 made this positional -
// see that module's header comment for why a position-blind version leaked
// a personal all-digit mailbox name); anything else is REFUSED outright, not
// silently redacted, since silent redaction of an argument is the exact bug
// this exists to prevent.
let storedArgs;
try {
  storedArgs = requireStorableArgs(args);
} catch (err) {
  console.error(`probe ${name}: refusing to record - ${err.message}`);
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
  const redactedData = redact(result.data);
  record = {
    probe: name,
    args: storedArgs,
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
    // Fix round 2 (task-5-rereview.md, Fix A - High): a SUCCESS PROFILE,
    // kept as a field separate from `shape` on purpose - see
    // research/successProfile.mjs for why a type-only fingerprint cannot
    // catch a single ok-style property silently flipping from working to
    // broken (or back), which `shape` alone is structurally blind to.
    successProfile: collectSuccessProfile(redactedData),
    data: redactedData,
  };
} catch (err) {
  // Two different refusals share this catch, and they must not be confused
  // for each other in the output: redact() rejecting an undeclared field, and
  // (fix round 4, task-5-rereview-3.md) collectSuccessProfile refusing to
  // build a profile whose coverage a path collision has quietly reduced -
  // see research/successProfile.mjs. Blaming redact() for the latter would
  // send the reader to the wrong file with the wrong remedy.
  const cause =
    err instanceof SuccessProfileCollisionError
      ? "this probe's output cannot be profiled without losing coverage."
      : "redact() rejected a field in this probe's output.";
  console.error(`probe ${name}: refusing to record - ${cause}\n${err.message}`);
  process.exit(1);
}

mkdirSync(RESULTS, { recursive: true });
writeFileSync(resolve(RESULTS, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
