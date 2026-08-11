// Usage: node research/verify.mjs
// Re-runs every recorded probe and fails if any SHAPE changed. Values and
// timings are expected to differ between runs and machines; shapes are not.
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "./harness.mjs";
import { redact } from "./redact.mjs";
import { shapeOf, diffShapes } from "./shape.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(HERE, "results");

let failures = 0;
const files = readdirSync(RESULTS).filter((f) => f.endsWith(".json")).sort();
if (files.length === 0) {
  console.error("no recordings in research/results/ - nothing to verify");
  process.exit(2);
}

for (const file of files) {
  // Everything for this file lives inside one try: a corrupt recording, a
  // probe that raises somewhere unexpected, or any other surprise becomes a
  // FAIL line for this file and the loop moves on to the rest, rather than
  // an uncaught stack trace that aborts verification of every other probe.
  try {
    const recorded = JSON.parse(readFileSync(resolve(RESULTS, file), "utf8"));
    const result = runProbe(recorded.probe, recorded.args ?? []);
    if (!result.ok) {
      console.error(`FAIL ${recorded.probe}: probe did not run: ${result.error}`);
      failures++;
      continue;
    }

    // Fingerprint the REDACTED value, exactly as record.mjs does (see the
    // comment there) - both sides of this comparison must be computed the
    // same way, or every probe reports a spurious mismatch the moment raw
    // and redacted fingerprints diverge. redact() can throw on a field the
    // allowlist does not recognize; that throw is caught by this file's
    // try below, same as any other unexpected failure for this probe.
    const diffs = diffShapes(recorded.shape, shapeOf(redact(result.data)));
    if (diffs.length > 0) {
      console.error(`FAIL ${recorded.probe}:\n  ${diffs.join("\n  ")}`);
      failures++;
      continue;
    }

    // Timing drift is informational only and must never affect `failures` or
    // the exit code - thresholds on wall-clock timing would be flaky across
    // machines and mailbox sizes; shape is the contract, timing is not.
    // Guarded against a recorded `seconds` of 0 (an instant probe rounds to
    // 0.000 when recorded): dividing by that baseline would either mask a
    // real slowdown behind a synthetic "1x" or print a meaningless
    // "Infinityx", so a zero or missing baseline just skips the note
    // instead of fabricating one.
    let note = "";
    if (recorded.seconds > 0) {
      const drift = result.seconds / recorded.seconds;
      if (Number.isFinite(drift) && drift > 3) {
        note = `  (${drift.toFixed(1)}x slower than recorded)`;
      }
    }
    console.log(`ok   ${recorded.probe}  ${result.seconds.toFixed(2)}s${note}`);
  } catch (err) {
    console.error(`FAIL ${file}: ${err.message}`);
    failures++;
  }
}

console.log(`\n${files.length - failures}/${files.length} probes match their recorded shape`);
process.exit(failures > 0 ? 1 : 0);
