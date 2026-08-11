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

// Fix round 1 (task-5-review, the CRITICAL finding): a shape match alone is
// NOT sufficient to prove a replay verified anything real. This project's
// own probes wrap a property read in a {ok, ...} (or {fetchOk, ...})
// success/failure shape SPECIFICALLY so a caught Mail-scripting exception
// has the same shape as a real value - see
// research/probes/04-message-props.js's timed(). That is good design for
// the probe's OWN robustness, but it means a probe whose args resolve to
// NOTHING real (the exact bug this fix round found: research/record.mjs
// used to redact a raw account name into a placeholder, which
// research/verify.mjs then replayed verbatim on every run) still produces a
// shape-stable, "successful-looking" result - every property caught its own
// exception, in the SAME shape a real value would have had. `diffShapes`
// above cannot see this: `ok: true` and `ok: false` are both `typeof
// "boolean"`, so the shape comparison is blind to which one actually
// happened. This check closes that gap generically, without needing to
// know each probe's own success/failure convention in detail: scan the
// live replay's data for every boolean field whose key is exactly "ok" or
// ends in "Ok" (covers this project's two conventions, `{ok: ...}` in
// 02/04 and `{fetchOk: ...}` in 12) - if at least one such field exists
// anywhere in the structure and EVERY one of them is `false`, the replay
// touched nothing but failure paths, and this file refuses to call that a
// match no matter what the shape comparison says. A probe with a genuine
// MIX of true/false (e.g. one property legitimately unavailable on one
// message) is not flagged - only a replay that reached real Mail data
// nowhere at all is.
function collectOkFlags(value, out) {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const v of value) collectOkFlags(v, out);
    return;
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === "boolean" && /ok$/i.test(k)) out.push(v);
    else collectOkFlags(v, out);
  }
}

function replayReachedOnlyFailurePaths(data) {
  const flags = [];
  collectOkFlags(data, flags);
  return flags.length > 0 && flags.every((flag) => flag === false);
}

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

    // The regression check this fix round adds: a shape match is necessary
    // but not sufficient - see the comment on replayReachedOnlyFailurePaths
    // above. Checked against the RAW live result, not the redacted copy:
    // booleans pass through redact() unchanged (only strings are ever
    // rewritten - see research/redact.mjs's walk()), so this would see the
    // identical flags either way, and reusing result.data directly avoids
    // depending on redact() having already been called successfully above.
    if (replayReachedOnlyFailurePaths(result.data)) {
      console.error(
        `FAIL ${recorded.probe}: shape matches, but this replay reached ` +
          `only failure paths (every "*ok" flag in the live data is ` +
          `false) - this proves the recorded shape is stable, not that ` +
          `Mail's object model was actually exercised. Args used: ` +
          `${JSON.stringify(recorded.args)}`
      );
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
