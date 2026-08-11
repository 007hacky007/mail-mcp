// Usage: node research/record.mjs <probe-name> [args...]
// Runs a probe, redacts the result, prints it, and writes results/<name>.json.
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "./harness.mjs";
import { redact, STANDARD_MAILBOXES } from "./redact.mjs";
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

// Fix round 1 (task-5-review): PROBE ARGUMENTS are replayed VERBATIM by
// research/verify.mjs (`runProbe(recorded.probe, recorded.args ?? [])`), not
// re-derived - reproducibility is the entire point of recording them. But
// `redact(args)` used to run the SAME generic, lossy redaction used for a
// probe's output `data`, which turns anything it doesn't specifically
// recognize (a real account name is not a standard mailbox name, so it does
// not survive redact.mjs's STANDARD_MAILBOXES passthrough) into an opaque
// descriptor like `<str len=5 chars=ascii>`. A descriptor is a fine stand-in
// for a VALUE that will only ever be read, never re-executed - but an
// argument gets fed straight back into `Mail.accounts.byName(...)` on every
// future verify run, and `<str len=5 chars=ascii>` resolves to no real
// account at all. The probe doesn't fail loudly at that point either -
// `.byName()` on a bad name returns a specifier lazily rather than throwing,
// so the failure surfaces one call later, inside whatever the probe does
// with it - and if the probe is written to catch that (as this project's
// probes increasingly are, precisely because Mail scripting errors are
// common), the result is a clean, valid, WRONG success: a shape-stable
// failure-path result that `research/verify.mjs` cannot distinguish from a
// real one. That is a false pass, and it is why this project's own
// `04-message-props`/`12-message-sizes` recordings verified 7/7 while never
// touching real Mail data on replay - see docs/apple-mail/03-object-model.md
// for the full story and the fix on the probe side (account SELECTORS
// instead of raw names).
//
// The fix on THIS side: an argument is stored VERBATIM only when it is
// PROVABLY non-personal - a decimal integer (an index selector), one of
// this project's own known selector keywords, or a name in redact.mjs's own
// STANDARD_MAILBOXES set (imported, not duplicated, so the two files cannot
// silently drift apart). Anything else is REFUSED outright, not silently
// redacted - silent redaction of an argument is exactly the bug this fixes,
// so falling back to it here would just recreate the same failure one line
// later. A probe author who hits this refusal has one correct fix: change
// the probe to accept a selector it resolves itself against the live
// account list (see research/probes/04-message-props.js's resolveAccount()
// for the pattern), not a raw name.
const KNOWN_SELECTOR_KEYWORDS = new Set(["largest-enabled", "gmail-style"]);
const DECIMAL_INTEGER_RE = /^\d+$/;

function isStorableVerbatim(arg) {
  return (
    DECIMAL_INTEGER_RE.test(arg) ||
    KNOWN_SELECTOR_KEYWORDS.has(arg) ||
    STANDARD_MAILBOXES.has(arg)
  );
}

// Deliberately does not echo the offending argument's value into the error
// message: an argument that fails this check is, by definition, exactly the
// kind of thing this project must not leak (there would be no reason to
// refuse it otherwise) - so the message names its POSITION, never its text.
function requireStorableArgs(rawArgs) {
  for (let i = 0; i < rawArgs.length; i++) {
    if (!isStorableVerbatim(rawArgs[i])) {
      throw new Error(
        `argument ${i} is not provably non-personal (it is not a decimal ` +
          `index, a known selector keyword [${[...KNOWN_SELECTOR_KEYWORDS].join(", ")}], ` +
          `or a standard mailbox name from redact.mjs's STANDARD_MAILBOXES). ` +
          `research/verify.mjs replays a probe with these EXACT args, so a raw ` +
          `account/mailbox name here would either leak personal data if stored ` +
          `verbatim, or silently redact into a placeholder that resolves to ` +
          `nothing real on replay - producing a false pass, which is the exact ` +
          `defect this check exists to catch. Change the probe to accept a ` +
          `selector it resolves itself (see research/probes/04-message-props.js) ` +
          `instead of a raw name.`
      );
    }
  }
  return rawArgs;
}

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
