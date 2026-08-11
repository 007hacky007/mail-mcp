// Usage: node research/verify.mjs
// Re-runs every recorded probe and fails if any SHAPE changed. Values and
// timings are expected to differ between runs and machines; shapes are not.
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "./harness.mjs";
import { redact } from "./redact.mjs";
import { shapeOf, diffShapes } from "./shape.mjs";
import { replayReachedOnlyFailurePaths } from "./failurePaths.mjs";
import { collectSuccessProfile, diffSuccessProfile } from "./successProfile.mjs";

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

    // Fix round 2 (task-5-rereview.md, Fix A - High): the success-profile
    // comparison - see research/successProfile.mjs for the full rationale.
    // `diffShapes` above can only ever compare TYPES, so a single ok-style
    // property silently flipping true<->false is invisible to it; this
    // check compares the recorded VALUES against the live ones, path by
    // path, and reports every path that differs, in either direction. Kept
    // as its own distinct FAIL message, separate from the shape diff and
    // from the blunter all-failure check below, so the three signals stay
    // individually readable in the output rather than merging into one.
    //
    // Only runs when the recording HAS a stored profile: an older
    // recording made before this fix round has no `successProfile` field
    // at all (`undefined`, not `{}`), and there is no baseline to compare
    // against - that is not the same as "every path was removed," which is
    // why this is SKIPPED, not diffed against `{}`, in that case. Checked
    // against the RAW live result, not a redacted copy: booleans pass
    // through redact() unchanged (research/redact.mjs's walk() only ever
    // rewrites strings), so this sees the identical flag values either way
    // and avoids depending on redact() having already run successfully
    // above.
    if (recorded.successProfile !== undefined) {
      const profileDiffs = diffSuccessProfile(recorded.successProfile, collectSuccessProfile(result.data));
      if (profileDiffs.length > 0) {
        console.error(`FAIL ${recorded.probe}: success-profile drift:\n  ${profileDiffs.join("\n  ")}`);
        failures++;
        continue;
      }
    }

    // The regression check fix round 1 added: a shape match is necessary
    // but not sufficient - see research/failurePaths.mjs. Kept as a
    // backstop for a recording that has no stored success profile to diff
    // against (so a total-failure replay is still caught even without a
    // baseline), even though for any recording that DOES have a profile,
    // the check above already catches - with more detail, naming every
    // path - the specific case this one is looking for (every flag false).
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
