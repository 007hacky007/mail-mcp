# Apple Mail Knowledge Archive Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce `docs/apple-mail/`, a self-contained, reproducible archive of how Mail.app scripting actually behaves, so the server can be built from it without re-researching anything.

**Architecture:** Every factual claim in the archive is backed by a committed, re-runnable probe. Probes are JXA scripts in `research/probes/`, driven by a zero-dependency Node harness that spawns `osascript` with an argv array (never a shell). Probe output is redacted, recorded as JSON in `research/results/`, and a verifier re-runs every probe and diffs the *shape* against the recording. The docs are written from those recordings, not from memory. Claims that could only be mined from the upstream repository, and claims about write operations (which this plan never performs), are marked `[unverified]`.

**Tech Stack:** Node 20+ (ESM, zero runtime dependencies), JXA (`osascript -l JavaScript`), macOS Mail.app. Node's built-in test runner (`node:test`) for the harness unit tests, so no dev dependency is needed either at this stage.

## Global Constraints

Copied verbatim from the spec. Every task's requirements implicitly include these.

- **Reads only.** This plan performs no mutation of Mail.app state. No drafts, no flags, no moves, no deletes, no mailbox creation. Write-operation recipes are documented as `[unverified]`.
- **No shell, ever.** `spawn`/`spawnSync` with an argv array. No `execSync`, no string-built commands, no `shell: true`.
- **No user-supplied value is ever interpolated into script text.** Values reach JXA via `argv` only.
- **All probe output is JSON on stdout, and nothing else.** Non-JSON stdout is a failure, not a value.
- **Never use a `whose` clause with a comparison operator.** Bulk-fetch property arrays and filter in JS.
- **Zero runtime dependencies.** `package.json` has no `dependencies` block at the end of this plan.
- **No network.** Nothing in `research/` imports `node:net`, `node:tls`, `node:http`, `node:https`, `node:dgram`, or calls `fetch`.
- **Privacy: no personal data in any committed file.** Real email addresses, display names, subject lines, and non-standard mailbox names must pass through the redactor before being written to `research/results/` or any doc. Standard mailbox names (`INBOX`, `Sent`, `Drafts`, `Trash`, `Junk`, `Archive`, `All Mail`, `Important`, `[Gmail]`) are structural and kept verbatim.
- **No unicode dashes or ellipses in any document.** Use only ASCII hyphen-minus (`-`) and `...`. This includes em-dash, en-dash, figure dash, minus sign, and the horizontal-ellipsis character.
- **Verified versus unverified.** A claim established by a committed probe on real hardware carries its timing. Everything else is prefixed `[unverified]`.
- **Upstream is MIT licensed and is a research input only.** Record findings and conclusions in our own words. Copy no code.

## Upstream reference

The research input is the working copy at `../apple-mail-mcp`. High-value files for mining:

| Path | What to mine |
|------|--------------|
| `src/utils/applescript.ts` (486 lines) | Execution model, timeouts, retry patterns, error mappings, buffer caps |
| `src/services/appleMailManager.ts` (4411 lines) | Every recipe, plus the design comments explaining why |
| `src/services/appleMailManager.gmailInbox.test.ts` | Gmail virtual-INBOX behavior |
| `src/services/replyForward.ts`, `src/services/appleMailManager.*.test.ts` | Draft/reply/forward recipes and their edge cases |
| `src/utils/mimeParse.ts` (379 lines) | Attachment extraction from raw MIME |
| `CHANGELOG.md` (119KB) | The bug ledger. Primary source for Task 12. |
| `CLAUDE.md`, `docs/` | Stated behavior, setup, TCC guidance |

## File Structure

```
~/Documents/mcp/mail-mcp/
  package.json                     name/type/engines/scripts only, no dependencies
  research/
    harness.mjs                    runProbe(): spawn osascript, time it, parse JSON
    redact.mjs                     redact(): strip personal data, stable pseudonyms
    record.mjs                     CLI: run a probe, redact, write results/<name>.json
    verify.mjs                     CLI: re-run all probes, diff SHAPE vs recordings
    shape.mjs                      shapeOf(): structural fingerprint of a JSON value
    probes/
      00-hello.js                  smoke: Mail reachable, argv round-trip
      01-argv-modes.js             the `--` discrepancy in file mode
      02-accounts.js               account properties incl. disabled accounts
      03-mailboxes.js              mailbox tree, full paths, counts
      04-message-props.js          per-property types and costs on one message
      05-bulk-fetch.js             bulk property arrays + per-property timing
      06-whose-vs-bulk.js          the 27.9s vs 5.2s comparison
      07-coldstart.js              cold versus warm round trip
      08-gmail-inbox.js            All Mail / Important versus literal INBOX
      09-unicode-dates.js          emoji/CJK subjects, Date round-tripping
      10-attachment-source.js      MIME source parse versus Mail attachment objects
      11-errors.js                 error text and exit codes for bad names
    results/                       redacted recordings, committed
    test/
      redact.test.mjs              unit tests, no Mail required
      shape.test.mjs               unit tests, no Mail required
  docs/apple-mail/
    README.md                      index, reading order, verified/unverified legend
    00-overview.md  01-execution-model.md  02-escaping-and-injection.md
    03-object-model.md  04-reading-recipes.md  05-search.md
    06-drafts.md  07-attachments.md  08-quirks-and-traps.md
    09-permissions-and-tcc.md  10-measurements.md
    11-upstream-bug-ledger.md  12-envelope-index.md
```

Responsibilities are split so that no file does two jobs: `harness.mjs` knows how to run a probe and nothing about mail; `redact.mjs` knows about personal data and nothing about probes; `shape.mjs` knows about structural fingerprints and nothing about either; each probe knows one question.

---

### Task 1: Probe harness

Everything later depends on this. It is also where the "no shell" and "no network" constraints become mechanically true.

**Files:**
- Create: `research/harness.mjs`
- Create: `research/probes/00-hello.js`
- Create: `research/probes/01-argv-modes.js`
- Create: `package.json`
- Create: `.gitignore` (append `research/results/*.raw.json`)

**Interfaces:**
- Consumes: nothing.
- Produces: `runProbe(name: string, args?: string[], timeoutMs?: number) => { ok: true, seconds: number, data: unknown } | { ok: false, seconds: number, error: string, status?: number }`. Exported from `research/harness.mjs`. Also exports `PROBE_DIR: string` and `argsOf(argv: string[]) => string[]` is NOT here (it lives inside each probe, see Step 3).

- [ ] **Step 1: Create `package.json` with no dependencies**

```json
{
  "name": "mail-mcp",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "Apple Mail MCP server. Drafts-only, zero runtime dependencies.",
  "engines": { "node": ">=20.0.0" },
  "os": ["darwin"],
  "scripts": {
    "test": "node --test research/test/",
    "probe": "node research/record.mjs",
    "verify": "node research/verify.mjs"
  }
}
```

There is deliberately no `dependencies` and no `devDependencies` key. Adding one is a spec violation that a reviewer should reject.

- [ ] **Step 2: Write the harness**

Create `research/harness.mjs`:

```js
// Runs a JXA probe and returns its parsed JSON output plus a wall-clock timing.
// No shell: spawnSync receives an argv array, so probe arguments can contain
// quotes, backslashes and spaces without any escaping layer.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PROBE_DIR = resolve(HERE, "probes");

// Mail message sources routinely exceed Node's 1MB default, which would surface
// as an opaque ENOBUFS. Upstream hit this and raised it; so do we.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// Bulk fetches over a large mailbox legitimately take tens of seconds.
const DEFAULT_TIMEOUT_MS = 120_000;

export function runProbe(name, args = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
  const script = resolve(PROBE_DIR, `${name}.js`);
  const started = process.hrtime.bigint();

  // "--" separates our arguments from osascript's own flags so a value that
  // begins with "-" is never mistaken for one. Probes strip it (see argsOf).
  const result = spawnSync(
    "osascript",
    ["-l", "JavaScript", script, "--", ...args],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      // SIGKILL, not SIGTERM: a wedged osascript blocked on an unresponsive
      // Mail.app ignores SIGTERM and piles up.
      killSignal: "SIGKILL",
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  if (result.error) {
    return { ok: false, seconds, error: `spawn failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    return {
      ok: false,
      seconds,
      status: result.status,
      error: stderr || `osascript exited ${result.status} with no stderr`,
    };
  }
  try {
    return { ok: true, seconds, data: JSON.parse(result.stdout) };
  } catch {
    return {
      ok: false,
      seconds,
      error: `non-JSON stdout (first 200 chars): ${result.stdout.slice(0, 200)}`,
    };
  }
}
```

- [ ] **Step 3: Write the smoke probe**

Create `research/probes/00-hello.js`. Note the `argsOf` helper: in file mode `argv` includes the `--` separator, unlike `-e` mode. Every probe repeats these two lines rather than importing, because a probe must stay runnable standalone from a terminal.

```js
// Smoke test: is Mail reachable, and does argv survive intact?
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

function run(argv) {
  const args = argsOf(argv);
  const Mail = Application("Mail");
  return JSON.stringify({
    mailReachable: true,
    accountCount: Mail.accounts.name().length,
    argvEcho: args,
  });
}
```

- [ ] **Step 4: Run the smoke probe and confirm argv fidelity**

```bash
cd ~/Documents/mcp/mail-mcp
node -e 'import("./research/harness.mjs").then(async ({runProbe}) => console.log(JSON.stringify(runProbe("00-hello", ["a \"quoted\" b", "back\\slash", "sp ace"]), null, 2)))'
```

Expected: `ok: true`, `accountCount` a positive integer, and `argvEcho` exactly `["a \"quoted\" b","back\\slash","sp ace"]` with no `--` and no escaping artifacts. If `argvEcho[0]` is `"--"`, the `argsOf` strip is broken. If the quotes or backslashes are altered, stop: the no-escaping premise of the whole design is wrong and the spec needs revisiting.

- [ ] **Step 5: Write the argv-modes probe**

This one documents finding 3.6 of the spec as a permanent, re-runnable artifact. Create `research/probes/01-argv-modes.js`:

```js
// Records exactly what argv looks like in file mode, including the leading
// separator, so the discrepancy with -e mode is a recorded fact and not folklore.
function run(argv) {
  return JSON.stringify({
    mode: "file",
    rawArgv: argv,
    rawArgvLength: argv.length,
    firstIsSeparator: argv[0] === "--",
  });
}
```

- [ ] **Step 6: Confirm the file-mode versus -e-mode difference**

```bash
cd ~/Documents/mcp/mail-mcp
echo "file mode:"
osascript -l JavaScript research/probes/01-argv-modes.js -- one two
echo "-e mode:"
osascript -l JavaScript -e 'function run(argv){return JSON.stringify({mode:"-e",rawArgv:argv,firstIsSeparator:argv[0]==="--"})}' -- one two
```

Expected: file mode reports `firstIsSeparator: true` with `rawArgv` of `["--","one","two"]`; `-e` mode reports `firstIsSeparator: false` with `rawArgv` of `["one","two"]`. Record the exact output, it goes into `01-execution-model.md` in Task 4.

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/mcp/mail-mcp
git add package.json .gitignore research/harness.mjs research/probes/00-hello.js research/probes/01-argv-modes.js
git commit -m "feat(research): zero-dependency JXA probe harness

spawnSync with an argv array, never a shell. Records the file-mode argv
separator discrepancy as a runnable probe."
```

---

### Task 2: Redaction

Probe output contains real email addresses, display names, subject lines and personal folder names. Nothing personal may reach a committed file. This task must land before any probe output is recorded.

**Files:**
- Create: `research/redact.mjs`
- Test: `research/test/redact.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `redact(value: unknown) => unknown` (deep, structure-preserving) and `newRedactor() => (value: unknown) => unknown` (fresh pseudonym maps, for tests). Both exported from `research/redact.mjs`.

Redaction rules, exhaustive:

| Input | Output |
|-------|--------|
| An email address anywhere in a string | `user1@example.com`, stably numbered per distinct address |
| `"Display Name" <a@b.com>` | `"Person 1" <user1@example.com>` |
| A key named `subject` | `<subject len=N chars=ascii|unicode>` |
| A key named `name` under an account, or `accountName` | `Account A`, `Account B`, ... |
| A key named `name`/`path` that is a mailbox, when not a standard name | `Folder 1`, preserving path separators |
| Standard mailbox names | kept verbatim: `INBOX`, `Sent`, `Drafts`, `Trash`, `Junk`, `Archive`, `All Mail`, `Important`, `[Gmail]` |
| Numbers, booleans, nulls, dates, counts, timings | kept verbatim |

- [ ] **Step 1: Write the failing tests**

Create `research/test/redact.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { newRedactor } from "../redact.mjs";

test("replaces a bare email address with a stable pseudonym", () => {
  const r = newRedactor();
  assert.equal(r("mail me at real.person@company.com ok"), "mail me at user1@example.com ok");
});

test("gives the same address the same pseudonym, and different ones different", () => {
  const r = newRedactor();
  assert.equal(r("a@x.com"), "user1@example.com");
  assert.equal(r("b@y.com"), "user2@example.com");
  assert.equal(r("a@x.com"), "user1@example.com");
});

test("replaces the display name in an RFC 5322 style address", () => {
  const r = newRedactor();
  assert.equal(r('"Jane Roe" <jane@corp.com>'), '"Person 1" <user1@example.com>');
});

test("reduces a subject to its length and character class", () => {
  const r = newRedactor();
  assert.deepEqual(r({ subject: "Q3 budget review" }), { subject: "<subject len=16 chars=ascii>" });
});

test("flags a non-ascii subject as unicode without revealing it", () => {
  const r = newRedactor();
  const out = r({ subject: "Rechnung fuer Mai \u2014 \u4f60\u597d" });
  assert.match(out.subject, /^<subject len=\d+ chars=unicode>$/);
});

test("keeps standard mailbox names verbatim", () => {
  const r = newRedactor();
  assert.deepEqual(
    r({ mailboxes: [{ name: "INBOX" }, { name: "All Mail" }, { name: "[Gmail]" }] }),
    { mailboxes: [{ name: "INBOX" }, { name: "All Mail" }, { name: "[Gmail]" }] }
  );
});

test("pseudonymizes a non-standard mailbox name but keeps the path shape", () => {
  const r = newRedactor();
  const out = r({ mailboxes: [{ name: "Thornlands", path: "Work/Thornlands/2026" }] });
  assert.equal(out.mailboxes[0].name, "Folder 1");
  assert.equal(out.mailboxes[0].path.split("/").length, 3);
  assert.ok(!out.mailboxes[0].path.includes("Thornlands"));
});

test("preserves numbers, booleans, nulls and timings", () => {
  const r = newRedactor();
  assert.deepEqual(
    r({ count: 17484, enabled: true, missing: null, seconds: 1.0485 }),
    { count: 17484, enabled: true, missing: null, seconds: 1.0485 }
  );
});

test("preserves array length and object key sets exactly", () => {
  const r = newRedactor();
  const out = r({ a: [1, 2, 3], b: { c: "x@y.com", d: 4 } });
  assert.equal(out.a.length, 3);
  assert.deepEqual(Object.keys(out.b).sort(), ["c", "d"]);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Documents/mcp/mail-mcp && node --test research/test/`
Expected: FAIL, cannot find module `../redact.mjs`.

- [ ] **Step 3: Implement the redactor**

Create `research/redact.mjs`. Structure-preserving is the hard requirement: shapes must survive so `verify.mjs` can diff them.

```js
const STANDARD_MAILBOXES = new Set([
  "INBOX", "Inbox", "Sent", "Sent Messages", "Sent Items", "Drafts",
  "Trash", "Deleted Messages", "Junk", "Spam", "Archive",
  "All Mail", "Important", "Starred", "[Gmail]", "[Google Mail]",
]);

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const DISPLAY_ADDR_RE = /"?([^"<>]+?)"?\s*<([^<>]+)>/g;
const ACCOUNT_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

export function newRedactor() {
  const emails = new Map();
  const people = new Map();
  const accounts = new Map();
  const folders = new Map();

  const pseudoEmail = (addr) => {
    const key = addr.trim().toLowerCase();
    if (!emails.has(key)) emails.set(key, `user${emails.size + 1}@example.com`);
    return emails.get(key);
  };
  const pseudoPerson = (name) => {
    const key = name.trim().toLowerCase();
    if (!people.has(key)) people.set(key, `Person ${people.size + 1}`);
    return people.get(key);
  };
  const pseudoAccount = (name) => {
    if (!accounts.has(name)) {
      const i = accounts.size;
      accounts.set(name, `Account ${ACCOUNT_LABELS[i] ?? `Z${i}`}`);
    }
    return accounts.get(name);
  };
  const pseudoFolder = (name) => {
    if (STANDARD_MAILBOXES.has(name)) return name;
    if (!folders.has(name)) folders.set(name, `Folder ${folders.size + 1}`);
    return folders.get(name);
  };

  const scrubText = (s) =>
    s
      .replace(DISPLAY_ADDR_RE, (_m, name, addr) => `"${pseudoPerson(name)}" <${pseudoEmail(addr)}>`)
      .replace(EMAIL_RE, (m) => pseudoEmail(m));

  const describeSubject = (s) => {
    const chars = /^[\x20-\x7e]*$/.test(s) ? "ascii" : "unicode";
    return `<subject len=${[...s].length} chars=${chars}>`;
  };

  const walk = (value, keyPath) => {
    const key = keyPath.at(-1);
    const parent = keyPath.at(-2);

    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...keyPath, String(i)]));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, [...keyPath, k]);
      return out;
    }
    if (typeof value !== "string") return value;

    if (key === "subject") return describeSubject(value);
    if (key === "accountName" || (key === "name" && parent === "accounts")) {
      return pseudoAccount(value);
    }
    if (key === "name" && (parent === "mailboxes" || parent === "boxes")) {
      return pseudoFolder(value);
    }
    if (key === "path" || key === "fullPath") {
      return value.split("/").map(pseudoFolder).join("/");
    }
    return scrubText(value);
  };

  return (value) => walk(value, []);
}

export const redact = (value) => newRedactor()(value);
```

Note on `keyPath`: array indices are pushed onto the path, so a mailbox inside `mailboxes[0]` has `parent === "0"`, not `"mailboxes"`. The walker therefore needs to skip numeric path segments when computing `parent`.

- [ ] **Step 4: Fix the parent lookup so array nesting works**

In `walk`, replace the `parent` line with a version that skips numeric segments:

```js
    const parent = [...keyPath].slice(0, -1).reverse().find((p) => !/^\d+$/.test(p));
```

This is the bug the `mailboxes: [{name: "INBOX"}]` and `preserves array length` tests exist to catch. Verify by re-running the tests.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd ~/Documents/mcp/mail-mcp && node --test research/test/`
Expected: PASS, 9 tests. If the standard-mailbox or path tests fail, the numeric-segment skip in Step 4 was not applied correctly.

- [ ] **Step 6: Prove it on real data before trusting it**

```bash
cd ~/Documents/mcp/mail-mcp
node -e '
import("./research/harness.mjs").then(async ({runProbe}) => {
  const { redact } = await import("./research/redact.mjs");
  const raw = runProbe("00-hello", ["me@real.example"]);
  console.log(JSON.stringify(redact(raw), null, 2));
});'
```

Expected: the echoed address appears as `user1@example.com`. Then, as a manual check, run the raw probe by hand and confirm by eye that every personal string in it would be caught. Write down anything the redactor misses and extend both the tests and the rules table before continuing. This step is the gate that protects every later commit.

- [ ] **Step 7: Commit**

```bash
cd ~/Documents/mcp/mail-mcp
git add research/redact.mjs research/test/redact.test.mjs
git commit -m "feat(research): structure-preserving redactor for probe output

Pseudonymizes addresses, display names, account and folder names; reduces
subjects to length and character class. Shapes survive so recordings stay
diffable."
```

---

### Task 3: Shape fingerprints, recorder, and verifier

This is what turns the archive from prose into something that fails loudly when macOS changes the object model. It also becomes the server's Tier 2 contract test later.

**Files:**
- Create: `research/shape.mjs`
- Create: `research/record.mjs`
- Create: `research/verify.mjs`
- Test: `research/test/shape.test.mjs`

**Interfaces:**
- Consumes: `runProbe` from `research/harness.mjs`; `redact` from `research/redact.mjs`.
- Produces: `shapeOf(value: unknown) => string` (a stable structural fingerprint), `diffShapes(a: string, b: string) => string[]` (human-readable differences, empty when identical). Both exported from `research/shape.mjs`. `record.mjs` and `verify.mjs` are CLIs with no exports.

- [ ] **Step 1: Write the failing tests**

Create `research/test/shape.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { shapeOf, diffShapes } from "../shape.mjs";

test("fingerprints primitives by type, not value", () => {
  assert.equal(shapeOf("anything"), shapeOf("else"));
  assert.equal(shapeOf(1), shapeOf(99999));
  assert.notEqual(shapeOf(1), shapeOf("1"));
});

test("fingerprints an object by its sorted key set and value types", () => {
  assert.equal(shapeOf({ a: 1, b: "x" }), shapeOf({ b: "y", a: 2 }));
  assert.notEqual(shapeOf({ a: 1 }), shapeOf({ a: 1, b: 2 }));
});

test("fingerprints an array by its element shape, not its length", () => {
  assert.equal(shapeOf([1, 2, 3]), shapeOf([9]));
  assert.notEqual(shapeOf([1]), shapeOf(["1"]));
});

test("an empty array is distinguishable from a populated one", () => {
  assert.notEqual(shapeOf([]), shapeOf([1]));
});

test("reports an added key as a difference", () => {
  const diffs = diffShapes(shapeOf({ a: 1 }), shapeOf({ a: 1, b: 2 }));
  assert.equal(diffs.length > 0, true);
  assert.match(diffs.join(" "), /b/);
});

test("reports no differences for identical shapes", () => {
  assert.deepEqual(diffShapes(shapeOf({ a: [1] }), shapeOf({ a: [7] })), []);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd ~/Documents/mcp/mail-mcp && node --test research/test/shape.test.mjs`
Expected: FAIL, cannot find module `../shape.mjs`.

- [ ] **Step 3: Implement shape fingerprints**

Create `research/shape.mjs`:

```js
// A structural fingerprint: types and key sets, never values. Two recordings of
// the same probe on different machines must produce the same fingerprint, so a
// difference means the object model changed, not that the mailbox differs.
export function shapeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    // Union the element shapes so a heterogeneous array is not reduced to its
    // first element, which would hide a property appearing on only some items.
    const inner = [...new Set(value.map(shapeOf))].sort().join("|");
    return `[${inner}]`;
  }
  if (typeof value === "object") {
    const entries = Object.keys(value)
      .sort()
      .map((k) => `${k}:${shapeOf(value[k])}`);
    return `{${entries.join(",")}}`;
  }
  return typeof value;
}

export function diffShapes(expected, actual) {
  if (expected === actual) return [];
  const keysOf = (s) => (s.match(/[A-Za-z_][A-Za-z0-9_]*(?=:)/g) ?? []);
  const e = new Set(keysOf(expected));
  const a = new Set(keysOf(actual));
  const diffs = [];
  for (const k of a) if (!e.has(k)) diffs.push(`unexpected key: ${k}`);
  for (const k of e) if (!a.has(k)) diffs.push(`missing key: ${k}`);
  if (diffs.length === 0) diffs.push(`shape changed:\n  expected ${expected}\n  actual   ${actual}`);
  return diffs;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd ~/Documents/mcp/mail-mcp && node --test research/test/shape.test.mjs`
Expected: PASS, 6 tests.

- [ ] **Step 5: Write the recorder CLI**

Create `research/record.mjs`:

```js
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

const record = {
  probe: name,
  args: redact(args),
  seconds: Number(result.seconds.toFixed(3)),
  shape: shapeOf(result.data),
  data: redact(result.data),
};

mkdirSync(RESULTS, { recursive: true });
writeFileSync(resolve(RESULTS, `${name}.json`), JSON.stringify(record, null, 2) + "\n");
console.log(JSON.stringify(record, null, 2));
```

- [ ] **Step 6: Write the verifier CLI**

Create `research/verify.mjs`:

```js
// Usage: node research/verify.mjs
// Re-runs every recorded probe and fails if any SHAPE changed. Values and
// timings are expected to differ between runs and machines; shapes are not.
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runProbe } from "./harness.mjs";
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
  const recorded = JSON.parse(readFileSync(resolve(RESULTS, file), "utf8"));
  const result = runProbe(recorded.probe, recorded.args ?? []);
  if (!result.ok) {
    console.error(`FAIL ${recorded.probe}: probe did not run: ${result.error}`);
    failures++;
    continue;
  }
  const diffs = diffShapes(recorded.shape, shapeOf(result.data));
  if (diffs.length > 0) {
    console.error(`FAIL ${recorded.probe}:\n  ${diffs.join("\n  ")}`);
    failures++;
  } else {
    const drift = result.seconds / (recorded.seconds || result.seconds);
    const note = drift > 3 ? `  (${drift.toFixed(1)}x slower than recorded)` : "";
    console.log(`ok   ${recorded.probe}  ${result.seconds.toFixed(2)}s${note}`);
  }
}

console.log(`\n${files.length - failures}/${files.length} probes match their recorded shape`);
process.exit(failures > 0 ? 1 : 0);
```

Note the timing drift is reported but never fails the run: thresholds on wall-clock timing would be flaky across machines and mailbox sizes.

- [ ] **Step 7: Record the two existing probes and verify**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 00-hello "sample@example.test"
node research/record.mjs 01-argv-modes one two
node research/verify.mjs
```

Expected: two recordings written to `research/results/`, then `2/2 probes match their recorded shape`. Open both JSON files and confirm by eye that they contain no personal data before committing.

- [ ] **Step 8: Commit**

```bash
cd ~/Documents/mcp/mail-mcp
git add research/shape.mjs research/record.mjs research/verify.mjs research/test/shape.test.mjs research/results/
git commit -m "feat(research): shape fingerprints, recorder and verifier

Every archive claim becomes a re-runnable probe with a recorded structural
fingerprint. verify.mjs fails when the Mail object model changes, which is
the Tier 2 contract test the spec asks for."
```

---

### Task 4: `01-execution-model.md`

Written first among the docs because every later recipe depends on knowing how a probe is invoked and bounded.

**Files:**
- Create: `docs/apple-mail/01-execution-model.md`
- Create: `research/probes/07-coldstart.js`
- Modify: `research/results/` (new recording)

**Interfaces:**
- Consumes: `runProbe`; the Task 1 Step 6 argv-mode output; upstream `src/utils/applescript.ts`.
- Produces: the documented facts that Tasks 5 through 14 cite instead of re-deriving.

- [ ] **Step 1: Write the cold-start probe**

Create `research/probes/07-coldstart.js`:

```js
// Measures the scripting-bridge warm-up penalty: the same trivial round trip,
// repeated, so the first-call cost is visible against the steady state.
function run() {
  const Mail = Application("Mail");
  const timings = [];
  for (let i = 0; i < 5; i++) {
    const t0 = $.NSDate.date;
    Mail.accounts.name();
    timings.push($.NSDate.date.timeIntervalSinceDate(t0));
  }
  return JSON.stringify({ inProcessRoundTrips: timings });
}
```

- [ ] **Step 2: Measure cold start properly**

The in-process loop above only measures warm round trips. Cold start is a per-process cost, so measure it from the outside, with Mail idle:

```bash
cd ~/Documents/mcp/mail-mcp
# Leave Mail untouched for a minute first, then:
node research/record.mjs 07-coldstart
echo "--- three consecutive fresh processes ---"
for i in 1 2 3; do
  node -e 'import("./research/harness.mjs").then(({runProbe}) => { const r = runProbe("00-hello"); console.log(r.seconds.toFixed(2) + "s"); })'
done
```

Expected shape: the first fresh process is dramatically slower than the next two. The spec recorded 6.80s then 0.15s. Record the actual numbers seen; they go in the doc and in `10-measurements.md`.

- [ ] **Step 3: Write the document**

Create `docs/apple-mail/01-execution-model.md` covering, in this order, each claim tagged verified with its timing or `[unverified]`:

1. **Invocation.** `osascript -l JavaScript <file> -- <args>` versus `osascript -l JavaScript -e '<source>' -- <args>`. Why file mode is preferred (auditable, runnable standalone, no interpolation site). The `--` discrepancy from Task 1 Step 6, with the exact recorded `argv` for both modes, and the two-line `argsOf` idiom.
2. **No shell.** Why `spawnSync("osascript", [...])` and not a command string. Quote the upstream pattern (`osascript -e '<script>'` with hand-escaped single quotes) as the thing being avoided and state the consequence plainly: a mail subject would be one escaping mistake away from command execution.
3. **Output channels.** JSON on stdout, diagnostics on stderr, exit status. What a non-zero exit looks like. That non-JSON stdout must be treated as failure, never parsed leniently.
4. **Buffer limits.** Node's 1MB `maxBuffer` default and the `ENOBUFS` failure it produces on a large message source. Why 64MB. Cite upstream's issue on this.
5. **Timeouts, two levels.** The in-script deadline set below the process timeout so Mail aborts from inside its own dispatch and releases the queue cleanly. `SIGKILL` over `SIGTERM`, with the reason: a wedged `osascript` ignores `SIGTERM`, and killing `osascript` does not stop work already dispatched into Mail, which is what wedges Mail for every subsequent call. Cite upstream's issue.
6. **The single-threaded dispatch queue.** Concurrent calls do not overlap; N concurrent calls cost about N times one call while each holds its deadline. Therefore serialize in-process and charge queue wait against the caller's deadline.
7. **Cold start.** The measured first-call versus warm-call figures from Step 2. The startup warm-up probe recommendation.
8. **Retry.** Which error patterns are genuinely transient (timeout, not responding, lost connection, busy) and why domain failures must never be retried.

- [ ] **Step 4: Check the document against the constraints**

```bash
cd ~/Documents/mcp/mail-mcp
f=docs/apple-mail/01-execution-model.md
grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode dashes present" || echo "ok: ascii only"
grep -niE 'TBD|TODO|FIXME' "$f" && echo "FAIL: placeholder present" || echo "ok: no placeholders"
grep -c 'unverified' "$f"
```

Expected: ascii only, no placeholders. The `unverified` count should be greater than zero (some claims are mined from upstream, not measured) and every such claim must carry the marker.

- [ ] **Step 5: Commit**

```bash
cd ~/Documents/mcp/mail-mcp
git add docs/apple-mail/01-execution-model.md research/probes/07-coldstart.js research/results/07-coldstart.json
git commit -m "docs(archive): execution model - invocation, timeouts, dispatch queue

Records the file-mode argv separator, the two-level timeout with SIGKILL,
the single-threaded dispatch queue, and measured cold versus warm start."
```

---

### Task 5: `03-object-model.md`

The foundational reference. Every later recipe cites it rather than restating property names and costs.

**Files:**
- Create: `docs/apple-mail/03-object-model.md`
- Create: `research/probes/02-accounts.js`
- Create: `research/probes/03-mailboxes.js`
- Create: `research/probes/04-message-props.js`

**Interfaces:**
- Consumes: `runProbe`, `redact`.
- Produces: the canonical property tables and the message-identity semantics that Tasks 6, 7, 8 and 11 depend on.

- [ ] **Step 1: Write the accounts probe**

Create `research/probes/02-accounts.js`. Note every property read is wrapped, because a disabled account raises on some of them and one throw would lose the whole result:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn) { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: String(e) }; } }

function run() {
  const Mail = Application("Mail");
  const accounts = Mail.accounts();
  return JSON.stringify({
    accountCount: accounts.length,
    accounts: accounts.map((a) => ({
      name: attempt(() => a.name()),
      enabled: attempt(() => a.enabled()),
      accountType: attempt(() => String(a.accountType())),
      emailAddresses: attempt(() => a.emailAddresses()),
      userName: attempt(() => a.userName()),
      serverName: attempt(() => a.serverName()),
      mailboxCount: attempt(() => a.mailboxes().length),
    })),
  });
}
```

- [ ] **Step 2: Record it and note the disabled-account behavior**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 02-accounts
```

Expected: every account present, including disabled ones. On this machine there are five accounts, two enabled and three disabled, and the disabled ones report zero mailboxes. Record which properties succeed and which raise on a disabled account. This matters: upstream shipped a bug that reported a Mail-disabled account as an unreadable one, and `list-accounts` must distinguish them.

- [ ] **Step 3: Write the mailboxes probe**

Create `research/probes/03-mailboxes.js`. Mailboxes nest, so full paths must be built by walking:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn, fallback) { try { return fn(); } catch { return fallback; } }

function walk(box, prefix, out, depth) {
  const name = attempt(() => box.name(), "<unreadable>");
  const path = prefix ? `${prefix}/${name}` : name;
  out.push({
    name,
    path,
    depth,
    messageCount: attempt(() => box.messages.length, -1),
    unreadCount: attempt(() => box.unreadCount(), -1),
  });
  const kids = attempt(() => box.mailboxes(), []);
  for (const kid of kids) walk(kid, path, out, depth + 1);
}

function run(argv) {
  const args = argsOf(argv);
  const Mail = Application("Mail");
  const wanted = args[0];
  const accounts = Mail.accounts().filter(
    (a) => !wanted || attempt(() => a.name(), "") === wanted
  );
  return JSON.stringify({
    accounts: accounts.map((a) => {
      const boxes = [];
      for (const b of attempt(() => a.mailboxes(), [])) walk(b, "", boxes, 0);
      return { name: attempt(() => a.name(), "<unreadable>"), mailboxes: boxes };
    }),
  });
}
```

- [ ] **Step 4: Record mailboxes for each enabled account**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 03-mailboxes
```

Expected: the full tree with paths and counts. Note explicitly, for the doc: whether nesting appears (a `[Gmail]` container is the common case), whether any leaf name occurs under more than one account, and how long the whole enumeration took. Ambiguous leaf names are the reason full paths are mandatory in tool output.

- [ ] **Step 5: Write the message-properties probe**

Create `research/probes/04-message-props.js`. It reads a single message so per-property cost and type are visible without a bulk fetch confusing the picture:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

function timed(fn) {
  const t0 = $.NSDate.date;
  try {
    const value = fn();
    return {
      ok: true,
      seconds: $.NSDate.date.timeIntervalSinceDate(t0),
      type: Array.isArray(value) ? "array" : typeof value,
      sample: typeof value === "string" ? value.slice(0, 60) : value,
    };
  } catch (e) {
    return { ok: false, seconds: $.NSDate.date.timeIntervalSinceDate(t0), error: String(e) };
  }
}

function run(argv) {
  const [accountName, mailboxName] = argsOf(argv);
  const Mail = Application("Mail");
  const box = Mail.accounts.byName(accountName).mailboxes.byName(mailboxName);
  const m = box.messages[0];
  return JSON.stringify({
    props: {
      id: timed(() => m.id()),
      messageId: timed(() => m.messageId()),
      subject: timed(() => m.subject()),
      sender: timed(() => m.sender()),
      dateReceived: timed(() => String(m.dateReceived())),
      dateSent: timed(() => String(m.dateSent())),
      readStatus: timed(() => m.readStatus()),
      flaggedStatus: timed(() => m.flaggedStatus()),
      flagIndex: timed(() => m.flagIndex()),
      messageSize: timed(() => m.messageSize()),
      mailboxName: timed(() => m.mailbox.name()),
      replyTo: timed(() => m.replyTo()),
      toRecipients: timed(() => m.toRecipients().length),
      ccRecipients: timed(() => m.ccRecipients().length),
      contentLength: timed(() => String(m.content()).length),
      sourceLength: timed(() => String(m.source()).length),
      attachmentCount: timed(() => m.mailAttachments().length),
    },
  });
}
```

- [ ] **Step 6: Record it and capture the cost hierarchy**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 04-message-props "<enabled account name>" INBOX
```

Expected: most properties are milliseconds; `source` is the expensive one and its length reveals why (it contains base64 attachments). Any property that raises is a fact worth recording, not a failure. Note the exact type of `id` (a number on this machine) and of `dateReceived` (a real Date).

- [ ] **Step 7: Write the document**

Create `docs/apple-mail/03-object-model.md`:

1. **Object graph.** `application` contains `accounts`, each containing nested `mailboxes`, each containing `messages`; plus `outgoing message` as a separate top-level class. Note what has no scripting representation at all.
2. **Account properties table** from Step 2: name, type, real type, whether it raises on a disabled account, cost. Include the disabled-account section explicitly.
3. **Mailbox properties table** from Step 4, plus nesting, full-path construction, and the ambiguous-leaf-name problem.
4. **Message properties table** from Step 6: property, type, cost class (cheap / bulk-only / expensive), and notes. `source` gets its own warning.
5. **Message identity, in full.** `id` is a per-mailbox integer, not stable across a move, and meaningless without its mailbox. Therefore: always return the full mailbox path with an id; always accept an optional account and mailbox hint on lookup so it need not scan everything; return the RFC `message-id` where present as the only identifier surviving a move. State the failure mode when this is ignored: intermittent, hard-to-reproduce "message not found".
6. **The `whose` warning**, cross-referencing `05-search.md` for the measurement.

- [ ] **Step 8: Verify the constraints and commit**

```bash
cd ~/Documents/mcp/mail-mcp
f=docs/apple-mail/03-object-model.md
grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode" || echo "ok"
grep -niE 'TBD|TODO|FIXME' "$f" && echo "FAIL: placeholder" || echo "ok"
node research/verify.mjs
git add docs/apple-mail/03-object-model.md research/probes/02-accounts.js research/probes/03-mailboxes.js research/probes/04-message-props.js research/results/
git commit -m "docs(archive): object model - accounts, mailboxes, messages, identity

Property tables with real types and cost classes, measured. Documents that
message id is a per-mailbox integer that does not survive a move, and the
consequences for every tool that accepts one."
```

---

### Task 6: `05-search.md` and the bulk-fetch measurements

The most valuable single finding in the archive: it is why no IMAP backend is needed.

**Files:**
- Create: `docs/apple-mail/05-search.md`
- Create: `research/probes/05-bulk-fetch.js`
- Create: `research/probes/06-whose-vs-bulk.js`

**Interfaces:**
- Consumes: `runProbe`, the property cost table from Task 5.
- Produces: the search strategy the server's `search-messages` implements, and the numbers `10-measurements.md` tabulates.

- [ ] **Step 1: Write the bulk-fetch probe**

Create `research/probes/05-bulk-fetch.js`:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

function run(argv) {
  const [accountName, mailboxName, needle] = argsOf(argv);
  const Mail = Application("Mail");
  const msgs = Mail.accounts.byName(accountName).mailboxes.byName(mailboxName).messages;
  const el = (t0) => $.NSDate.date.timeIntervalSinceDate(t0);

  const out = { messageCount: msgs.length, fetch: {} };
  let t0 = $.NSDate.date; const ids = msgs.id();           out.fetch.id = el(t0);
  t0 = $.NSDate.date; const subjects = msgs.subject();     out.fetch.subject = el(t0);
  t0 = $.NSDate.date; const senders = msgs.sender();       out.fetch.sender = el(t0);
  t0 = $.NSDate.date; const dates = msgs.dateReceived();   out.fetch.dateReceived = el(t0);
  t0 = $.NSDate.date; const read = msgs.readStatus();      out.fetch.readStatus = el(t0);
  out.fetchTotal = Object.values(out.fetch).reduce((a, b) => a + b, 0);

  t0 = $.NSDate.date;
  const lower = String(needle || "").toLowerCase();
  let hits = 0;
  for (let i = 0; i < subjects.length; i++) {
    if (String(subjects[i]).toLowerCase().indexOf(lower) !== -1) hits++;
  }
  out.jsFilterSeconds = el(t0);
  out.hits = hits;
  out.arrayLengths = {
    id: ids.length, subject: subjects.length, sender: senders.length,
    dateReceived: dates.length, readStatus: read.length,
  };
  out.idType = typeof ids[0];
  out.dateSample = String(dates[0]);
  return JSON.stringify(out);
}
```

- [ ] **Step 2: Record it on the largest available mailbox**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 05-bulk-fetch "<largest enabled account>" INBOX invoice
```

Expected, based on the spec's measurement of a 17,484-message mailbox: roughly 0.7 to 1.1s per property, about 4.5s for five, and a JS filter in single-digit milliseconds. Confirm `arrayLengths` all equal `messageCount`: a short array would mean the bulk fetch is silently partial, which would invalidate the entire strategy. Confirm `idType` is `number`.

- [ ] **Step 3: Write the whose-comparison probe**

Create `research/probes/06-whose-vs-bulk.js`:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

function run(argv) {
  const [accountName, mailboxName, needle] = argsOf(argv);
  const Mail = Application("Mail");
  const msgs = Mail.accounts.byName(accountName).mailboxes.byName(mailboxName).messages;
  const el = (t0) => $.NSDate.date.timeIntervalSinceDate(t0);
  const out = {};

  let t0 = $.NSDate.date;
  const filtered = msgs.whose({ subject: { _contains: needle } });
  const n = filtered.length;
  out.whoseCountSeconds = el(t0);
  out.whoseCount = n;

  t0 = $.NSDate.date;
  const subjects = filtered.subject();
  out.whoseFetchSeconds = el(t0);
  out.whoseMatched = subjects.length;

  t0 = $.NSDate.date;
  const all = msgs.subject();
  const lower = String(needle).toLowerCase();
  let hits = 0;
  for (let i = 0; i < all.length; i++) {
    if (String(all[i]).toLowerCase().indexOf(lower) !== -1) hits++;
  }
  out.bulkSeconds = el(t0);
  out.bulkHits = hits;
  return JSON.stringify(out);
}
```

- [ ] **Step 4: Record it and confirm both approaches agree on the answer**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 06-whose-vs-bulk "<largest enabled account>" INBOX invoice
```

Expected: `whoseCount` equals `bulkHits` (same answer), and `whoseCountSeconds + whoseFetchSeconds` is several times `bulkSeconds`. The spec measured 27.85s versus 5.19s for 19 hits. If the counts disagree, that is itself a finding worth documenting, and the bulk result is the trustworthy one.

- [ ] **Step 5: Write the document**

Create `docs/apple-mail/05-search.md`:

1. **The headline.** Substring search over a 17k-message mailbox costs about 5 seconds locally with no credentials. State it up front, because it is the fact that makes an IMAP backend unnecessary.
2. **Why bulk fetch works.** `mailbox.messages.subject()` is one Apple Event returning an array, not N events. This is the entire performance story.
3. **The measurement table** from Step 2, per property.
4. **The `whose` trap.** The Step 4 numbers side by side. That upstream uses `whose` throughout and that this is most of their slowness. The nuance that the measurement is for `_contains` and that equality on an indexed property may differ, and that it does not matter because identity lookups come from bulk `id[]` arrays.
5. **Fetch only what the query needs.** A subject-only search needs `id[]` and `subject[]`, about 1.8s, not the full five.
6. **Bounding an unscoped search.** Per-mailbox size guard, per-account time budget, and the requirement to report which mailboxes were scanned and which were skipped so an empty result is never ambiguous between "nothing matched" and "we gave up".
7. **Unmeasured risks, stated plainly.** Linear extrapolation to 100k messages is extrapolation. Memory of five 17k string arrays is clearly fine; at 500k it may not be. Chunking by message index range is the fallback; sketch it.

- [ ] **Step 6: Verify and commit**

```bash
cd ~/Documents/mcp/mail-mcp
f=docs/apple-mail/05-search.md
grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode" || echo "ok"
node research/verify.mjs
git add docs/apple-mail/05-search.md research/probes/05-bulk-fetch.js research/probes/06-whose-vs-bulk.js research/results/
git commit -m "docs(archive): search - bulk fetch beats whose by 5x, measured

Bulk property arrays read 17k subjects in ~1s; a whose _contains filter
takes 27.9s for the same answer bulk-plus-JS-filter gets in 5.2s. This is
why no IMAP backend is needed."
```

---

### Task 7: `04-reading-recipes.md`

**Files:**
- Create: `docs/apple-mail/04-reading-recipes.md`

**Interfaces:**
- Consumes: the probes and tables from Tasks 5 and 6.
- Produces: a complete, runnable recipe per read tool, which Plan 2 turns into `jxa/*.js`.

- [ ] **Step 1: Write one complete recipe per read tool**

Create `docs/apple-mail/04-reading-recipes.md`. Nine sections, one per read tool: `doctor`, `list-accounts`, `list-mailboxes`, `get-unread-count`, `list-messages`, `search-messages`, `get-message`, `get-thread`, `list-attachments`. Each section contains, with no exceptions:

- **Inputs**, as the argv positions the script expects.
- **The complete script.** Runnable as-is, including the `argsOf` idiom and error wrapping. Not a fragment, not a reference to another section.
- **The output shape**, copied from the corresponding recording in `research/results/`.
- **Measured timing**, or `[unverified]` if not measured.
- **Traps**, specific to that recipe.

Two traps are mandatory to include because they are known upstream bugs:

- `get-message` must not fetch `source` unless HTML is explicitly requested. Upstream fetched it unconditionally and returned the whole raw MIME blob, base64 attachments included, mislabeled as the HTML body. Show the conditional fetch.
- `get-unread-count` uses the mailbox's cached `unreadCount`, not a filter over messages. Show both and note the cost difference.

- [ ] **Step 2: Verify every script in the document actually runs**

Each recipe must be executed before the doc is committed. Extract each into a scratch file under `$TMPDIR` and run it:

```bash
cd ~/Documents/mcp/mail-mcp
# For each recipe: save to $TMPDIR/recipe.js then
osascript -l JavaScript "$TMPDIR/recipe.js" -- "<account>" "INBOX" | head -c 400
```

Expected: valid JSON matching the documented shape. A recipe that does not run is a plan failure, not a documentation nit. Fix the doc, not the expectation.

- [ ] **Step 3: Commit**

```bash
cd ~/Documents/mcp/mail-mcp
f=docs/apple-mail/04-reading-recipes.md
grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode" || echo "ok"
git add docs/apple-mail/04-reading-recipes.md
git commit -m "docs(archive): reading recipes - one complete runnable script per read tool

Every recipe executed against real Mail before committing. Includes the
conditional source fetch that upstream got wrong."
```

---

### Task 8: `07-attachments.md`

**Files:**
- Create: `docs/apple-mail/07-attachments.md`
- Create: `research/probes/10-attachment-source.js`

**Interfaces:**
- Consumes: `runProbe`; upstream `src/utils/mimeParse.ts`.
- Produces: the attachment enumeration and extraction approach for Plan 2.

- [ ] **Step 1: Write the probe comparing both sources of truth**

Create `research/probes/10-attachment-source.js`. It compares what Mail's attachment objects report against what parsing the raw MIME source reveals, on the same message:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn, fallback) { try { return fn(); } catch { return fallback; } }

function run(argv) {
  const [accountName, mailboxName, indexRaw] = argsOf(argv);
  const Mail = Application("Mail");
  const box = Mail.accounts.byName(accountName).mailboxes.byName(mailboxName);
  const msgs = box.messages;

  // Find a message that has attachments, scanning from newest.
  const limit = Math.min(msgs.length, Number(indexRaw) || 200);
  let target = null, scanned = 0;
  for (let i = 0; i < limit; i++) {
    scanned++;
    if (attempt(() => msgs[i].mailAttachments().length, 0) > 0) { target = msgs[i]; break; }
  }
  if (!target) return JSON.stringify({ found: false, scanned });

  const el = (t0) => $.NSDate.date.timeIntervalSinceDate(t0);
  let t0 = $.NSDate.date;
  const objects = attempt(() => target.mailAttachments(), []).map((a) => ({
    name: attempt(() => a.name(), null),
    mimeType: attempt(() => a.mimeType(), null),
    fileSize: attempt(() => a.fileSize(), null),
    downloaded: attempt(() => a.downloaded(), null),
  }));
  const objectSeconds = el(t0);

  t0 = $.NSDate.date;
  const source = String(attempt(() => target.source(), ""));
  const sourceSeconds = el(t0);

  const boundaries = (source.match(/boundary="?[^"\s;]+/gi) || []).length;
  const dispositions = (source.match(/Content-Disposition:\s*attachment/gi) || []).length;
  const filenames = (source.match(/filename\*?=/gi) || []).length;
  const encodedWords = (source.match(/=\?[A-Za-z0-9-]+\?[BQbq]\?/g) || []).length;

  return JSON.stringify({
    found: true, scanned,
    objects, objectSeconds,
    sourceBytes: source.length, sourceSeconds,
    mime: { boundaries, dispositions, filenames, encodedWords },
  });
}
```

- [ ] **Step 2: Record it**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 10-attachment-source "<enabled account>" INBOX 300
```

Expected: a message with attachments is found, `objects` lists them, and `sourceBytes` is large relative to the message. Compare the object-reported names and types against the MIME `dispositions`/`filenames` counts. Note the `encodedWords` count: a non-zero value means RFC 2047 encoded filenames are present in real mail on this machine, which the extractor must decode.

- [ ] **Step 3: Write the document**

Create `docs/apple-mail/07-attachments.md`:

1. **Two sources of truth**, and why the MIME source wins for enumeration: measured comparison from Step 2.
2. **Cost.** `source` is the expensive property. Fetch it once and parse, never repeatedly.
3. **MIME structure walk.** Multipart boundaries, nesting, `Content-Disposition`, `Content-Type`, `Content-Transfer-Encoding`. Which parts count as attachments versus inline versus body alternatives.
4. **Filename decoding.** RFC 2047 encoded-words, RFC 2231 continuations and charset-tagged `filename*`. Cite the encodedWords count from Step 2 as evidence this is not theoretical.
5. **Size.** Reported versus actual after base64 decoding, and the roughly 4/3 inflation.
6. **Extraction and writing to disk.** Filenames from mail are untrusted: sanitize, reject traversal, resolve symlinks, confine to an allowlisted root. State that no tool returns attachment bytes into the conversation, and why (any message becomes a channel for pushing arbitrary content at the model).
7. **The upstream bug.** Fetching `source` unconditionally and returning it as HTML.

- [ ] **Step 4: Verify and commit**

```bash
cd ~/Documents/mcp/mail-mcp
f=docs/apple-mail/07-attachments.md
grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode" || echo "ok"
node research/verify.mjs
git add docs/apple-mail/07-attachments.md research/probes/10-attachment-source.js research/results/
git commit -m "docs(archive): attachments - MIME source parsing over Mail objects

Measured comparison of both sources on a real attachment-bearing message,
plus encoded-filename decoding and the untrusted-filename containment rules."
```

---

### Task 9: `08-quirks-and-traps.md`

**Files:**
- Create: `docs/apple-mail/08-quirks-and-traps.md`
- Create: `research/probes/08-gmail-inbox.js`
- Create: `research/probes/09-unicode-dates.js`

**Interfaces:**
- Consumes: `runProbe`; upstream `appleMailManager.gmailInbox.test.ts`.
- Produces: the inbox-resolution rule and character/date handling rules for Plan 2.

- [ ] **Step 1: Write the Gmail inbox probe**

This verifies the single most consequential quirk: on Gmail accounts the literal `INBOX` is nearly empty and real mail lives in `All Mail` and `Important`, which are nested and so do not resolve by a flat lookup. Create `research/probes/08-gmail-inbox.js`:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn, fallback) { try { return fn(); } catch { return fallback; } }

function collect(box, prefix, out) {
  const name = attempt(() => box.name(), "<unreadable>");
  const path = prefix ? `${prefix}/${name}` : name;
  out.push({ name, path, messageCount: attempt(() => box.messages.length, -1) });
  for (const kid of attempt(() => box.mailboxes(), [])) collect(kid, path, out);
}

function run(argv) {
  const [accountName] = argsOf(argv);
  const Mail = Application("Mail");
  const acct = Mail.accounts.byName(accountName);

  const all = [];
  for (const b of attempt(() => acct.mailboxes(), [])) collect(b, "", all);

  const byLowerName = (n) => all.filter((b) => b.name.toLowerCase() === n);
  const flatLookup = (n) => attempt(() => acct.mailboxes.byName(n).messages.length, "RAISED");

  return JSON.stringify({
    totalMailboxes: all.length,
    isGmailStyle: all.some((b) => b.name.toLowerCase() === "all mail"),
    literalInbox: byLowerName("inbox"),
    allMail: byLowerName("all mail"),
    important: byLowerName("important"),
    // Does a flat, non-recursive lookup find the nested special mailboxes?
    flatLookupInbox: flatLookup("INBOX"),
    flatLookupAllMail: flatLookup("All Mail"),
    containerNames: all.filter((b) => b.path.indexOf("/") !== -1).map((b) => b.path.split("/")[0]),
  });
}
```

- [ ] **Step 2: Record it against the Gmail account**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 08-gmail-inbox "<gmail account name>"
```

Expected, per upstream's finding: `isGmailStyle` true, `literalInbox` reporting a message count far below `allMail`, and `flatLookupAllMail` returning `"RAISED"` because `All Mail` is nested inside a `[Gmail]` container. Also record the same probe against the non-Gmail account to confirm the ordinary single-INBOX case, so the doc can state when the special handling applies and when it must not.

- [ ] **Step 3: Write the unicode and dates probe**

Create `research/probes/09-unicode-dates.js`:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

function run(argv) {
  const [accountName, mailboxName] = argsOf(argv);
  const Mail = Application("Mail");
  const msgs = Mail.accounts.byName(accountName).mailboxes.byName(mailboxName).messages;
  const subjects = msgs.subject();
  const dates = msgs.dateReceived();

  let nonAscii = 0, astral = 0, maxLen = 0, empty = 0;
  for (let i = 0; i < subjects.length; i++) {
    const s = String(subjects[i] == null ? "" : subjects[i]);
    if (s.length === 0) empty++;
    if (!/^[\x20-\x7e]*$/.test(s)) nonAscii++;
    // Surrogate pairs: emoji and other astral-plane characters.
    if (/[\uD800-\uDBFF][\uDC00-\uDFFF]/.test(s)) astral++;
    if ([...s].length > maxLen) maxLen = [...s].length;
  }

  const d = dates[0];
  return JSON.stringify({
    sampled: subjects.length,
    nonAsciiSubjects: nonAscii,
    astralSubjects: astral,
    emptySubjects: empty,
    longestSubjectChars: maxLen,
    dateIsDateObject: Object.prototype.toString.call(d) === "[object Date]",
    dateIsoRoundTrip: new Date(d).toISOString(),
    dateGetTimeType: typeof new Date(d).getTime(),
  });
}
```

- [ ] **Step 4: Record it**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 09-unicode-dates "<enabled account>" INBOX
```

Expected: a non-zero `nonAsciiSubjects` count on any real mailbox, `dateIsDateObject` true, and a clean ISO round trip. `emptySubjects` greater than zero means null or empty subjects occur in real mail and every recipe must tolerate them. Record whether `astralSubjects` is non-zero, since it determines whether length must be counted in code points rather than UTF-16 units.

- [ ] **Step 5: Write the document**

Create `docs/apple-mail/08-quirks-and-traps.md`, one section per trap, each stating the symptom, the cause, and the rule:

1. **Gmail's virtual INBOX**, with the Step 2 numbers. The rule: detect a Gmail-style account by the presence of an `All Mail` mailbox, then treat `All Mail` plus `Important` as the receiving set. They are nested, so they must be found by walking and matching names, never by a flat `mailboxes.byName()`. Include the negative case so non-Gmail accounts keep ordinary behavior.
2. **Mailbox name aliases across providers.** The alias sets for inbox, sent, drafts, trash, junk and archive. Mined from upstream, marked `[unverified]` for providers not present on this machine.
3. **Ambiguous leaf names.** Why the same leaf under two accounts must be refused with both candidates named, never guessed.
4. **Disabled accounts.** They enumerate, report zero mailboxes, and must not be reported as unreadable. Reference the Task 5 recording.
5. **Localized macOS.** Mail's scripting terminology versus localized display names. Why anything that depends on an English UI term is fragile, and that this is the reason upstream edited a plist directly for smart mailboxes.
6. **Unicode.** The Step 4 counts. Code points versus UTF-16 units. Null and empty subjects.
7. **Dates.** JXA returns real `Date` objects; ISO round trip verified. The contrast with AppleScript, where a date must be built property by property, marked `[unverified]` since this project does not do it.
8. **The `[Gmail]` container**, and nesting generally: full paths are the only safe identifier.

- [ ] **Step 6: Verify and commit**

```bash
cd ~/Documents/mcp/mail-mcp
f=docs/apple-mail/08-quirks-and-traps.md
grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode" || echo "ok"
node research/verify.mjs
git add docs/apple-mail/08-quirks-and-traps.md research/probes/08-gmail-inbox.js research/probes/09-unicode-dates.js research/results/
git commit -m "docs(archive): quirks - Gmail virtual INBOX, aliases, unicode, dates

Verifies that a Gmail account's literal INBOX is near-empty and that All Mail
is nested beyond flat lookup, plus unicode and Date handling on real mail."
```

---

### Task 10: `11-upstream-bug-ledger.md`

The highest-value file in the archive and the one that cannot be reconstructed later, because it lives in a third-party changelog that may not survive.

**Files:**
- Create: `docs/apple-mail/11-upstream-bug-ledger.md`

**Interfaces:**
- Consumes: upstream `CHANGELOG.md` (119KB), the test suite, and referenced issue numbers.
- Produces: the trap list that Plan 2's tasks and the server's tests are written against.

- [ ] **Step 1: Extract every fix entry from the upstream changelog**

```bash
cd ../apple-mail-mcp
grep -nE '^###? |^- ' CHANGELOG.md | grep -iE 'fix|bug|issue|#[0-9]+' | wc -l
grep -oE '#[0-9]+' CHANGELOG.md | sort -u | wc -l
git log --oneline | grep -icE '^[a-f0-9]+ fix'
```

Expected: a large count on all three. This establishes the scale before reading. Then read `CHANGELOG.md` in full, in sections, extracting every entry that describes a behavior that was wrong.

- [ ] **Step 2: Write the ledger**

Create `docs/apple-mail/11-upstream-bug-ledger.md`. Group by theme, not chronologically, because the reader wants "what can bite me in attachments" rather than "what happened in 2.8.15". One table per theme, with columns: symptom, root cause, fix, and our status (avoided by design / must handle / not applicable).

Themes, with the entries already identified during spec research that must appear:

- **Execution and transport.** The 1MB `maxBuffer` default causing `ENOBUFS` on large sources. `SIGTERM` failing to kill a wedged `osascript`, and killing `osascript` not stopping work already dispatched into Mail. Transport failures being reported as zero or empty results, which is the most dangerous class because a failed search looks exactly like a search that found nothing. Raw `Command failed: osascript -e '<entire script>'` leaking to users.
- **Serialization.** Printable triple-pipe delimiters colliding with field values (a subject containing one shifted every subsequent field and silently corrupted the parse), and the move to ASCII control characters. Our status: avoided by design, `JSON.stringify`.
- **Reply and forward.** `reply msg with opening window` plus `set content` silently no-oping because the compose window was not ready, producing empty bodies from background processes, which is how an MCP server always runs. The full table of approaches that failed: `delay 1`/`delay 2`, `set html content`, System Events keystrokes (blocked from a background process), `make new outgoing message` with a matching subject (loses threading headers), manual headers on an outgoing message (the class exposes no headers property). The fix: `without opening window`.
- **Reading.** `source` fetched unconditionally and returned as HTML.
- **Search and counts.** Mailboxes too large to scan before the Apple Event timeout. Concurrent calls to an expensive tool not overlapping and each burning its own deadline in the queue. Counting a mailbox once per backend to avoid double-counting. Partial results reported as complete totals.
- **Accounts and mailboxes.** A Mail-disabled account reported as unreadable. Duplicate accounts by wire identity. Ambiguous same-leaf mailbox names resolved by guessing.
- **Process lifecycle.** Orphaned servers surviving a force-quit parent and lingering with held resources, detected by `ppid === 1`.

For each entry, our status column must be filled in. An entry marked "avoided by design" must say which design decision avoids it, so a future change that removes that decision is visibly re-opening a known bug.

- [ ] **Step 3: Cross-check the ledger against the design's invariants**

```bash
cd ~/Documents/mcp/mail-mcp
grep -c 'avoided by design' docs/apple-mail/11-upstream-bug-ledger.md
grep -c 'must handle' docs/apple-mail/11-upstream-bug-ledger.md
```

Every "must handle" entry needs a corresponding requirement in the spec or a note that Plan 2 must add one. Read the spec's section 5 invariants alongside the ledger and confirm each "avoided by design" claim actually maps to a numbered invariant. Any that does not is either a wrong claim or a missing invariant; resolve it rather than leaving it.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/mcp/mail-mcp
f=docs/apple-mail/11-upstream-bug-ledger.md
grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode" || echo "ok"
git add docs/apple-mail/11-upstream-bug-ledger.md
git commit -m "docs(archive): upstream bug ledger

Every bug upstream hit, grouped by theme, with root cause, fix, and whether
our design avoids it or must handle it. Mined from a 119KB changelog that
may not outlive this archive."
```

---

### Task 11: `02-escaping-and-injection.md` and `06-drafts.md`

Two documents that are mined rather than measured: escaping describes a problem this design does not have, and drafts are write operations this plan does not perform. Both are therefore largely `[unverified]`, and that must be visible on the page.

**Files:**
- Create: `docs/apple-mail/02-escaping-and-injection.md`
- Create: `docs/apple-mail/06-drafts.md`

**Interfaces:**
- Consumes: upstream `src/utils/applescript.ts`, `src/services/appleMailManager.ts` (the escaping helpers and draft recipes), `src/services/replyForward.ts`, `src/security.test.ts`; the Task 1 argv verification.
- Produces: the draft recipes Plan 2 implements and verifies for the first time.

- [ ] **Step 1: Read upstream's escaping implementation**

```bash
cd ../apple-mail-mcp
sed -n '320,375p' src/services/appleMailManager.ts
sed -n '82,101p' src/utils/applescript.ts
sed -n '160,200p' src/security.test.ts
```

Note the two distinct layers: `escapeForShell` (single quotes, for the `osascript -e '...'` wrapper) and `escapeForAppleScript` / `escapeForAppleScriptBody` (backslashes then double quotes, for AppleScript string literals). Note the ordering dependency: backslash must be escaped before quote or the escaping eats itself.

- [ ] **Step 2: Write the escaping document**

Create `docs/apple-mail/02-escaping-and-injection.md`:

1. **The two layers**, with upstream's actual approach described and the ordering dependency explained.
2. **How each fails.** A value containing a single quote breaking out of the shell wrapper. A value containing a backslash-quote sequence breaking out of the AppleScript literal. The user-facing symptom upstream documents: silent failure, an email that sends with a mangled or empty body, with no error.
3. **Why the JSON escaping requirement propagates to the caller.** Upstream's `CLAUDE.md` instructs the model to double-escape backslashes in tool arguments. Note this as the tell: when a design needs the caller to escape correctly for it to be safe, the design is the problem.
4. **How argv removes both layers**, with the verified Task 1 evidence: quotes, backslashes and spaces surviving intact through `spawnSync` with an argv array and `osascript` file mode.
5. **The residual rule.** No value is ever interpolated into script text, and scripts live on disk so there is no concatenation site where it could happen.

Mark the failure-mode claims `[unverified]` where they are reasoned from reading upstream's code rather than demonstrated. Do not construct a working injection to verify them.

- [ ] **Step 3: Read upstream's draft, reply and forward recipes**

```bash
cd ../apple-mail-mcp
grep -n 'make new outgoing message' -A 30 src/services/appleMailManager.ts | head -80
sed -n '2168,2270p' src/services/appleMailManager.ts
sed -n '1,60p' src/services/replyForward.ts
grep -n 'without opening window' src/services/appleMailManager.ts CLAUDE.md
```

- [ ] **Step 4: Write the drafts document**

Create `docs/apple-mail/06-drafts.md`. Every recipe here is `[unverified]`: this plan performs no writes. Plan 2 verifies them and updates the markers.

1. **`create-draft`.** `make new outgoing message` with `visible: false`. Recipients as child objects (`to recipient`, `cc recipient`, `bcc recipient`), one per address, not a joined string. Attachments. Saving without sending. The JXA translation of each AppleScript form, since upstream's recipes are in AppleScript and must be translated.
2. **`reply-draft`.** `reply` with `without opening window`, then set content, then save. State the requirement unambiguously and why: with a compose window, `set content` silently no-ops because the window is not ready, giving an empty body, and this reproduces specifically from background processes, which is how an MCP server always runs.
3. **`forward-draft`.** Same shape, plus that a forward starts a new conversation and carries no threading headers.
4. **Threading.** That Mail sets `In-Reply-To` and `References` itself on a `reply`, because the reply object knows its original, and that these headers cannot be set manually on an outgoing message because the class exposes no headers property.
5. **The failed-approaches table** from the bug ledger, reproduced here in full so a reader working on drafts does not need to cross-reference: `delay` before `set content`, `set html content`, System Events keystrokes, `make new outgoing message` with a matching subject, manual headers.
6. **A boxed note that no recipe in this file sends.** No `send` command appears anywhere in the archive's draft recipes, and that is deliberate per the spec's section 8.1.

- [ ] **Step 5: Confirm no send recipe leaked in**

```bash
cd ~/Documents/mcp/mail-mcp
grep -niE '\bsend\b' docs/apple-mail/06-drafts.md
```

Expected: every match is prose explaining that sending is out of scope, never a code line invoking `send`. Any code line containing a `send` call is a spec violation and must be removed.

- [ ] **Step 6: Verify and commit**

```bash
cd ~/Documents/mcp/mail-mcp
for f in docs/apple-mail/02-escaping-and-injection.md docs/apple-mail/06-drafts.md; do
  grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode in $f" || echo "ok: $f"
done
git add docs/apple-mail/02-escaping-and-injection.md docs/apple-mail/06-drafts.md
git commit -m "docs(archive): escaping layers and draft recipes

Documents the two hand-escaped layers argv removes, and the draft/reply/
forward recipes with the without-opening-window requirement. Draft recipes
are marked unverified: this plan performs no writes."
```

---

### Task 12: `09-permissions-and-tcc.md`

**Files:**
- Create: `docs/apple-mail/09-permissions-and-tcc.md`

**Interfaces:**
- Consumes: upstream `docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md`; live `codesign` inspection.
- Produces: the install guidance the README depends on, and the `doctor` tool's signing check.

- [ ] **Step 1: Inspect the actual Node binary signing status**

```bash
which node
codesign -dvvv "$(which node)" 2>&1 | grep -E 'Identifier|Signature|TeamIdentifier|Authority' | head
codesign -dvvv /usr/bin/osascript 2>&1 | grep -E 'Identifier|Authority' | head -3
```

Record whether this machine's Node is ad-hoc signed or Developer-ID signed. `Signature=adhoc` or `TeamIdentifier=not set` means ad-hoc, which is the problem case. Also record the Node path, since a version-manager path that changes on upgrade is itself part of the problem.

- [ ] **Step 2: Read upstream's TCC document**

```bash
cd ../apple-mail-mcp
cat docs/NODE-RUNTIME-AND-TCC-PERMISSIONS.md
```

- [ ] **Step 3: Write the document**

Create `docs/apple-mail/09-permissions-and-tcc.md`:

1. **What this server needs.** Automation access to Mail.app, and nothing else. Explicitly not Full Disk Access, and the two features dropped to keep it that way (contacts lookup, the Envelope Index backend).
2. **What each grant unlocks**, and what fails without it. The exact error text seen when Automation is denied, cross-referencing `01-execution-model.md`.
3. **How TCC identifies the requesting binary**, and the ad-hoc-signing problem: Homebrew's Node is ad-hoc signed, so its cdhash changes on every upgrade and TCC treats it as a brand-new binary, re-prompting forever. Include the Step 1 detection command and this machine's actual result.
4. **The fix.** An official Developer-ID-signed Node at a stable path outside any version manager, with the MCP host configured to point at it directly. Note that the grant then survives Node updates.
5. **Verification.** How `doctor` checks this, and what it reports.
6. **Headless and SSH caveats**, marked `[unverified]` where taken from upstream rather than tested.

- [ ] **Step 4: Commit**

```bash
cd ~/Documents/mcp/mail-mcp
f=docs/apple-mail/09-permissions-and-tcc.md
grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode" || echo "ok"
git add docs/apple-mail/09-permissions-and-tcc.md
git commit -m "docs(archive): permissions and TCC

Automation only, no Full Disk Access. Documents the ad-hoc-signed-Node cdhash
problem that causes endless re-prompting, with this machine's actual signing
status and the Developer-ID fix."
```

---

### Task 13: `12-envelope-index.md` and `11-errors` probe

The rejected alternative, documented as an escape hatch, plus the error-behavior probe that `01-execution-model.md` and the server's error classification both need.

**Files:**
- Create: `docs/apple-mail/12-envelope-index.md`
- Create: `research/probes/11-errors.js`
- Modify: `docs/apple-mail/01-execution-model.md` (add the recorded error text)

**Interfaces:**
- Consumes: `runProbe`; read-only filesystem inspection.
- Produces: the error taxonomy the server classifies against.

- [ ] **Step 1: Write the error-behavior probe**

Create `research/probes/11-errors.js`. It deliberately triggers each failure and records what Mail actually says, so error classification is built on recorded text rather than guesses:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn) {
  try { const v = fn(); return { raised: false, value: typeof v === "object" ? "<object>" : v }; }
  catch (e) { return { raised: true, error: String(e), number: e.errorNumber === undefined ? null : e.errorNumber }; }
}

function run(argv) {
  const [goodAccount] = argsOf(argv);
  const Mail = Application("Mail");
  return JSON.stringify({
    badAccount: attempt(() => Mail.accounts.byName("NoSuchAccount0xdeadbeef").name()),
    badMailbox: attempt(() => Mail.accounts.byName(goodAccount).mailboxes.byName("NoSuchBox0xdeadbeef").messages.length),
    badMessageIndex: attempt(() => Mail.accounts.byName(goodAccount).mailboxes.byName("INBOX").messages[999999999].id()),
    badProperty: attempt(() => Mail.accounts.byName(goodAccount).noSuchProperty()),
  });
}
```

- [ ] **Step 2: Record the error probe, expecting a non-zero exit for the raw form**

```bash
cd ~/Documents/mcp/mail-mcp
node research/record.mjs 11-errors "<enabled account>"
echo "--- unwrapped, to capture stderr and exit status ---"
osascript -l JavaScript -e 'function run(){ return Application("Mail").accounts.byName("NoSuchAccount0xdeadbeef").name() }'; echo "exit=$?"
```

Expected: the wrapped probe succeeds with each case reporting `raised: true` and its error text; the unwrapped call writes `execution error: Error: Error: Can't get object. (-1728)` to stderr and exits 1. The point to record: the message names no object, so it cannot be turned into a useful error after the fact. This is the evidence for the validate-names-first invariant.

- [ ] **Step 3: Add the recorded error taxonomy to the execution-model document**

Append a section to `docs/apple-mail/01-execution-model.md` titled "Error text and classification", containing: the recorded text for each of the four failure cases from Step 2, the exit status, which channel it appears on, and the three-class taxonomy the server uses (transport failure, domain failure, partial success). State the rule that a transport failure must never be surfaced as an empty result, and cite the ledger entry where upstream did exactly that.

- [ ] **Step 4: Inspect the Envelope Index read-only**

```bash
ls -la ~/Library/Mail/ 2>&1 | head
find ~/Library/Mail -maxdepth 2 -name 'Envelope Index*' 2>/dev/null | head
```

If access is denied, that is itself the finding to record: it demonstrates the Full Disk Access requirement. Do not grant FDA to explore. If the file is listable, record its size and modification time only. Do not open or query it: this project rejected it as a backend and a read of the live index is not needed to document the option.

- [ ] **Step 5: Write the envelope-index document**

Create `docs/apple-mail/12-envelope-index.md`, kept short and explicitly non-committal:

1. **What it is.** Mail's own SQLite index under `~/Library/Mail/V*/MailData/`, holding the envelope data (subjects, senders, dates, flags, mailbox membership) that makes Mail's UI fast.
2. **What it would buy.** Millisecond search and counts, and visibility into mail without Mail.app running.
3. **What it costs.** Full Disk Access for the whole process, which is the grant this design deliberately avoids. A private schema Apple changes between releases, so it needs a version probe and a fallback. Bodies still require reading `.emlx` files or falling back to scripting.
4. **Why it was rejected**, and the one condition that would revive it: JXA bulk fetch ceasing to be fast enough at much larger mailbox sizes. Cross-reference the unmeasured-risk section of `05-search.md`.
5. **The Step 4 access result**, recorded as evidence for the FDA claim.
6. **An explicit statement that nothing in this project reads it**, so a reader does not go looking for the code.

- [ ] **Step 6: Verify and commit**

```bash
cd ~/Documents/mcp/mail-mcp
for f in docs/apple-mail/12-envelope-index.md docs/apple-mail/01-execution-model.md; do
  grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' "$f" && echo "FAIL: unicode in $f" || echo "ok: $f"
done
node research/verify.mjs
git add docs/apple-mail/12-envelope-index.md docs/apple-mail/01-execution-model.md research/probes/11-errors.js research/results/
git commit -m "docs(archive): error taxonomy and the rejected Envelope Index option

Records Mail's actual error text for four failure cases, showing it names no
object and so must be prevented by validating names first. Documents the
SQLite index as an escape hatch that nothing in this project reads."
```

---

### Task 14: `10-measurements.md`, `00-overview.md`, and the index

Written last, because the overview can only be honest once everything it summarizes exists, and the measurements document aggregates recordings from every earlier task.

**Files:**
- Create: `research/measurements.mjs`
- Create: `docs/apple-mail/10-measurements.md` (generated)
- Create: `docs/apple-mail/00-overview.md`
- Create: `docs/apple-mail/README.md`

**Interfaces:**
- Consumes: every file in `research/results/`.
- Produces: the archive's entry point.

- [ ] **Step 1: Write the measurements generator**

Create `research/measurements.mjs`. Generated rather than hand-written, so the timings can never drift from the recordings:

```js
// Usage: node research/measurements.mjs > docs/apple-mail/10-measurements.md
// Regenerates the measurements document from the committed recordings so no
// timing in the archive can drift from the probe that produced it.
import { readdirSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = resolve(HERE, "results");

const sysctl = (key) => {
  try { return execFileSync("sysctl", ["-n", key], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
};
const sw = (flag) => {
  try { return execFileSync("sw_vers", [flag], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
};

const lines = [];
lines.push("# Measurements");
lines.push("");
lines.push("Generated by `node research/measurements.mjs` from the recordings in");
lines.push("`research/results/`. Do not edit by hand: regenerate instead.");
lines.push("");
lines.push("## Hardware and software");
lines.push("");
lines.push(`- macOS: ${sw("-productVersion")} (build ${sw("-buildVersion")})`);
lines.push(`- CPU: ${sysctl("machdep.cpu.brand_string")}`);
lines.push(`- Cores: ${sysctl("hw.ncpu")}`);
lines.push(`- Memory bytes: ${sysctl("hw.memsize")}`);
lines.push(`- Node: ${process.version}`);
lines.push("");
lines.push("## Probe wall-clock times");
lines.push("");
lines.push("| Probe | Seconds | Notes |");
lines.push("|-------|---------|-------|");

const files = readdirSync(RESULTS).filter((f) => f.endsWith(".json")).sort();
for (const file of files) {
  const r = JSON.parse(readFileSync(resolve(RESULTS, file), "utf8"));
  const inner = r.data && typeof r.data === "object" ? r.data : {};
  const notes = [];
  if (inner.messageCount !== undefined) notes.push(`${inner.messageCount} messages`);
  if (inner.fetchTotal !== undefined) notes.push(`bulk fetch ${inner.fetchTotal.toFixed(2)}s`);
  if (inner.jsFilterSeconds !== undefined) notes.push(`JS filter ${inner.jsFilterSeconds.toFixed(4)}s`);
  lines.push(`| \`${r.probe}\` | ${r.seconds.toFixed(2)} | ${notes.join(", ") || "-"} |`);
}

lines.push("");
lines.push("## Per-property bulk fetch");
lines.push("");
const bulkFile = files.find((f) => f.startsWith("05-bulk-fetch"));
if (bulkFile) {
  const r = JSON.parse(readFileSync(resolve(RESULTS, bulkFile), "utf8"));
  lines.push(`Mailbox size: ${r.data.messageCount} messages.`);
  lines.push("");
  lines.push("| Property | Seconds |");
  lines.push("|----------|---------|");
  for (const [k, v] of Object.entries(r.data.fetch)) {
    lines.push(`| \`${k}[]\` | ${v.toFixed(2)} |`);
  }
  lines.push(`| **all five** | **${r.data.fetchTotal.toFixed(2)}** |`);
  lines.push(`| filter in JS | ${r.data.jsFilterSeconds.toFixed(4)} |`);
} else {
  lines.push("No bulk-fetch recording found. Run `node research/record.mjs 05-bulk-fetch ...` first.");
}

lines.push("");
lines.push("## Reproducing");
lines.push("");
lines.push("```bash");
lines.push("node research/verify.mjs                    # re-run every probe, check shapes");
lines.push("node research/measurements.mjs > docs/apple-mail/10-measurements.md");
lines.push("```");
lines.push("");

console.log(lines.join("\n"));
```

- [ ] **Step 2: Generate the measurements document and check it**

```bash
cd ~/Documents/mcp/mail-mcp
node research/measurements.mjs > docs/apple-mail/10-measurements.md
grep -nP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' docs/apple-mail/10-measurements.md && echo "FAIL: unicode" || echo "ok"
head -40 docs/apple-mail/10-measurements.md
```

Expected: a populated hardware section, one row per recording, and a per-property bulk-fetch table. If the bulk-fetch section reports no recording, Task 6 was not completed and this task cannot finish.

- [ ] **Step 3: Write the overview**

Create `docs/apple-mail/00-overview.md`. Written last so it can be accurate rather than aspirational:

1. **What Mail.app exposes to scripting**, and what it does not. The Apple Event bridge, the scripting dictionary, the single-threaded dispatch queue.
2. **The three ways to drive it**: AppleScript, JXA, ScriptingBridge. What each costs. Why this project chose JXA, in three sentences with the numbers: `JSON.stringify` instead of a hand-rolled delimiter protocol, `argv` instead of two hand-escaped layers, and bulk property arrays instead of per-message iteration.
3. **The five facts that matter most**, each one line with a cross-reference: bulk fetch is one Apple Event per property; `whose` with a comparison is catastrophically slow; `id` is a per-mailbox integer that does not survive a move; Gmail's literal INBOX is nearly empty; Mail's errors name no object so names must be validated first.
4. **What this archive is and is not.** It is a record of verified behavior with reproducible probes. It is not a manual for the upstream project, and it contains none of its code.
5. **How to verify it still holds** on a new machine or after a macOS update: `node research/verify.mjs`.

- [ ] **Step 4: Write the index**

Create `docs/apple-mail/README.md`: a one-line description per document, a suggested reading order for someone implementing the server (`00`, `01`, `03`, `04`, `05`, then the rest as needed), the verified versus `[unverified]` legend, the probe and verification commands, and a note that `10-measurements.md` is generated and must not be hand-edited.

- [ ] **Step 5: Final whole-archive check**

```bash
cd ~/Documents/mcp/mail-mcp
echo "--- all 14 docs present? ---"
ls docs/apple-mail/ | wc -l
echo "--- unicode dashes anywhere in the archive? ---"
grep -rnP '[\x{2010}-\x{2015}\x{2212}\x{2026}]' docs/ && echo "FAIL" || echo "ok: ascii only"
echo "--- placeholders anywhere? ---"
grep -rniE '\bTBD\b|\bTODO\b|\bFIXME\b' docs/ && echo "FAIL" || echo "ok: none"
echo "--- personal data leaked into recordings? ---"
grep -rniE '[a-z0-9._%+-]+@(gmail|realdomain1|realdomain2)' research/results/ docs/ && echo "FAIL: real address present" || echo "ok: no real addresses"
echo "--- no network imports? ---"
grep -rnE "node:(net|tls|http|https|dgram)|\bfetch\(" research/ && echo "FAIL" || echo "ok: no network"
echo "--- no shell usage? ---"
grep -rnE "execSync|shell:\s*true" research/ && echo "FAIL" || echo "ok: no shell"
echo "--- unit tests ---"
node --test research/test/
echo "--- probe shapes ---"
node research/verify.mjs
```

Expected: 14 files in `docs/apple-mail/` (13 numbered plus README), ascii only, no placeholders, no real addresses, no network or shell usage, all unit tests passing, all probes matching their recorded shapes. Every one of these is a hard gate. A failure here means the archive is not done.

- [ ] **Step 6: Commit**

```bash
cd ~/Documents/mcp/mail-mcp
git add research/measurements.mjs docs/apple-mail/10-measurements.md docs/apple-mail/00-overview.md docs/apple-mail/README.md
git commit -m "docs(archive): generated measurements, overview and index

Measurements are generated from the committed recordings so no timing can
drift from the probe that produced it. Completes the 13-document archive."
```

---

## Self-Review

**1. Spec coverage.** Section 7 of the spec lists 13 archive documents. Mapping: `00-overview` Task 14; `01-execution-model` Task 4, extended Task 13; `02-escaping-and-injection` Task 11; `03-object-model` Task 5; `04-reading-recipes` Task 7; `05-search` Task 6; `06-drafts` Task 11; `07-attachments` Task 8; `08-quirks-and-traps` Task 9; `09-permissions-and-tcc` Task 12; `10-measurements` Task 14; `11-upstream-bug-ledger` Task 10; `12-envelope-index` Task 13. All 13 covered.

Spec section 3's verified findings each get a permanent probe: 3.1 argv (Task 1), 3.2 bulk fetch (Task 6), 3.3 whose (Task 6), 3.4 cold start (Task 4), 3.5 error text (Task 13), 3.6 argv modes (Task 1). Spec section 10's Tier 2 contract tests are delivered as `research/verify.mjs` in Task 3. The privacy constraint is enforced by Task 2 before any recording is committed, and re-checked in Task 14 Step 5.

Not covered by this plan, by design: the server itself (spec sections 4, 5, 6, 9 and the Tier 1 and Tier 3 tests), which is Plan 2. Spec section 8's security model is documented here but enforced in code there.

**2. Placeholder scan.** No "TBD", "TODO", "implement later", or "similar to Task N". Every code step carries complete runnable code. The doc-writing steps enumerate exact required sections and the exact claims each must establish, with the probe recording that supplies the evidence, rather than saying "write the document".

**3. Type consistency.** `runProbe(name, args, timeoutMs)` returning `{ok, seconds, data|error, status?}` is defined in Task 1 and consumed unchanged by `record.mjs` and `verify.mjs` in Task 3. `redact(value)` and `newRedactor()` are defined in Task 2 and consumed by `record.mjs`. `shapeOf(value)` and `diffShapes(expected, actual)` are defined in Task 3 and consumed by both CLIs. `argsOf(argv)` is deliberately duplicated inline in every probe rather than imported, and Task 1 Step 3 states why: a probe must run standalone from a terminal. Every probe filename referenced in a `record.mjs` invocation is created by some task: `00-hello` and `01-argv-modes` (Task 1), `02-accounts`, `03-mailboxes`, `04-message-props` (Task 5), `05-bulk-fetch`, `06-whose-vs-bulk` (Task 6), `07-coldstart` (Task 4), `08-gmail-inbox`, `09-unicode-dates` (Task 9), `10-attachment-source` (Task 8), `11-errors` (Task 13).

One inconsistency found and fixed inline: Task 2 Step 3's `walk` computes `parent` as `keyPath.at(-2)`, which breaks for objects nested inside arrays. Rather than hide it, Step 4 is a dedicated fix step, and two of the Step 1 tests exist specifically to catch it.
