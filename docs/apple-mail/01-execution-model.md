# 01. Execution Model

How a script actually gets from this project into Mail.app and back: which
process runs it, how arguments reach it, what its output looks like on
success and on every failure, how long it is allowed to run, why it is
allowed to run only one at a time, and which failures are worth retrying.
Every later document in this archive assumes the reader already knows this
one; none of them re-derive it.

## How to read this document

A claim carries one of two markers:

- A plain statement of fact followed by a measurement (a number, a quoted
  command and its output, or a citation of a file in this repository) is
  **verified**: something this project actually ran and observed, on this
  machine, and you can re-run the same command to check it yourself.
- A statement prefixed `[unverified]` was mined from reading the upstream
  project's source (`../apple-mail-mcp`, MIT
  licensed) or its changelog, but has not been executed as part of this
  archive. It is still useful - it is the reason upstream built what it
  built - but treat the specific numbers in it as someone else's
  measurement on someone else's machine, not a fact about this one.

This project touches Mail.app read-only. No claim below about write
operations, retries actually firing against a real failure, or concurrent
calls actually colliding inside Mail.app has been reproduced here; all of
that is upstream's experience, marked accordingly.

## 1. Invocation: file mode versus `-e` mode

`osascript` runs a JXA (`-l JavaScript`) script two ways:

```bash
# File mode: the script is a path on disk.
osascript -l JavaScript research/probes/01-argv-modes.js -- one two

# -e mode: the script is the source text itself, as one argv element.
osascript -l JavaScript -e 'function run(argv){return JSON.stringify({rawArgv:argv})}' -- one two
```

Both forms accept a top-level `run(argv)` function as the script's entry
point and both pass extra command-line arguments through to it. Neither
form requires escaping the *values* that follow `--`: `argv` is a plain
array of strings, assembled by the OS from `spawnSync`'s argument array (see
section 2), not parsed out of a larger string.

This project uses file mode exclusively (`research/harness.mjs`, which
every probe goes through). Two reasons, neither about escaping since both
modes are equally safe on that front:

- **Auditable.** The exact bytes `osascript` executes are a file already
  sitting in this repository, reviewable, diffable in `git log`, and
  runnable by copy-pasting one line from a terminal - no reconstruction of
  an inline string required. Every probe under `research/probes/` is
  runnable standalone this way, which is why every probe repeats the same
  two-line `argsOf` helper below instead of importing it from a shared
  module.
- **No temptation to template the script body.** `-e` mode's source text is
  itself one argv element. Used correctly (as in the comparison command
  above, where the values still arrive through `argv`), it is exactly as
  safe as file mode. But a project with many probes that reaches for `-e`
  repeatedly creates pressure to build that source string dynamically per
  call instead of maintaining one file per probe - and a dynamically built
  script body is precisely the shell/AppleScript double-escaping trap
  section 2 exists to avoid. One probe, one file, argv-only inputs removes
  that pressure structurally rather than relying on discipline.

### The `--` discrepancy

File mode and `-e` mode disagree about what `argv[0]` is. **Verified** -
`research/probes/01-argv-modes.js`, run both ways (Task 1 Step 6). The
literal values below are quoted verbatim from that step's terminal
transcript in
`.superpowers/sdd/2026-08-11-apple-mail-knowledge-archive/task-1-report.md`,
not from `research/results/01-argv-modes.json`: that file holds only a
single **file-mode** run (`runProbe` never invokes `-e` mode, so there is
no `-e`-mode entry to find there at all) and, being a committed recording,
has its `args`/`rawArgv` values redacted to placeholder descriptors rather
than the literal `"one"`/`"two"`/`"--"` shown here:

```
file mode:
{"mode":"file","rawArgv":["--","one","two"],"rawArgvLength":3,"firstIsSeparator":true}
-e mode:
{"mode":"-e","rawArgv":["one","two"],"firstIsSeparator":false}
```

`osascript`'s own `--` is meant to separate its flags from the script's
arguments. In file mode, JXA's `run(argv)` receives the raw process argv
*including* that literal `"--"` as `argv[0]`. In `-e` mode it does not
appear. Code that assumes `argv[0]` is the first real value works when
tested with `-e` and then silently shifts every argument by one position
the moment it is switched to file mode: what was meant to be the first
argument becomes the literal string `"--"`, and the real first argument is
read as if it were the second. That failure is quiet - no error, no
exception, just the wrong mailbox name landing in the account-name slot -
which is exactly why this repo pins the fact down as a recorded probe
rather than trusting anyone to remember it.

The fix is two lines, repeated verbatim at the top of every probe in this
project rather than imported, so each file stays runnable standalone:

```js
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

function run(argv) {
  const args = argsOf(argv);
  // ... use args, not argv, from here on
}
```

## 2. No shell: argv arrays, not command strings

`research/harness.mjs` invokes `osascript` with `spawnSync` and an argument
array:

```js
spawnSync(
  "osascript",
  ["-l", "JavaScript", script, "--", ...args],
  { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER_BYTES, stdio: ["ignore", "pipe", "pipe"] }
);
```

There is no shell in this path. `spawnSync` calls `execve(2)` with an
argument vector the OS hands to the new process pre-split; there is no
command-line string for anything to re-parse, so there is nothing for a
value inside `args` to break out of.

**Verified.** Task 1 confirmed values survive this path byte-for-byte,
including characters that are meaningful to a shell:

```
node -e 'import("./research/harness.mjs").then(async ({runProbe}) =>
  console.log(JSON.stringify(runProbe("00-hello",
    ["a \"quoted\" b", "back\\slash", "sp ace"]), null, 2)))'
```

returned `argvEcho` of exactly `["a \"quoted\" b","back\\slash","sp ace"]` -
the double quote, the single backslash, and the embedded space all arrived
intact, with no escaping artifacts (task-1-report.md, Step 4).

Contrast this with what upstream had to do, because it built and ran a
*shell command string*. `src/utils/applescript.ts` wraps the AppleScript
body in single quotes for a `sh -c`-style invocation and hand-escapes any
single quote already inside the script:

```typescript
// escapeForShell(): "Replace single quotes with: end quote, escaped quote,
// start quote. This is the standard shell escaping pattern for
// single-quoted strings."
function escapeForShell(script: string): string {
  return script.replace(/'/g, "'\\''");
}
// ...
const command = `osascript -e '${preparedScript}'`;
execSync(command, { encoding: "utf8", timeout: timeoutMs, ... });
```

(`src/utils/applescript.ts` lines 96-100, 370-375, 392.) This is two nested
escaping problems, not one: the AppleScript source has to be valid
AppleScript once unwrapped, *and* the whole thing has to survive being
sitting inside single quotes on a shell command line first. `escapeForShell`
only handles the second problem, and only for the one character (`'`) it
knows about. `[unverified]` - no attempt has been made in this project to
break `escapeForShell`, and none should be made against the live upstream
project - but the mechanism is not in doubt: any value that reaches
`command` without going through `escapeForShell` first, or any shell
metacharacter `escapeForShell` was never asked to think about, is executed
by the shell as command line, not treated as inert text. A mail subject
containing an unescaped `'` followed by shell syntax would not merely
corrupt the AppleScript - it would be interpreted by `sh` as the end of the
quoted string and the start of a new command. `spawnSync` with an argv
array removes that risk by removing the shell, not by escaping harder.

## 3. Output channels: stdout, stderr, exit status

The contract every probe in this project follows: **JSON on stdout, and
nothing else.** Diagnostics, if any, go to stderr. Exit status is 0 for
success, nonzero for failure. `research/harness.mjs` enforces this by
construction - `stdio: ["ignore", "pipe", "pipe"]` discards the child's
stdin and captures stdout/stderr separately, and `JSON.parse(result.stdout)`
is the only thing that turns captured stdout into a value.

**Verified**, on the success path: all four probes recorded so far
(`00-hello`, `01-argv-modes`, `07-coldstart`, `12-message-sizes`) returned
`ok: true` with `data` parsed straight from stdout - see
`research/results/*.json`.

The nonzero-exit case, generically (not Mail-specific - a thrown error
inside any JXA `run()`), **verified** directly:

```
$ osascript -l JavaScript -e 'function run(){ throw new Error("boom"); }'
execution error: Error: Error: boom (-2700)
$ echo $?
1
```

Empty stdout, the error on stderr, exit status 1. `research/harness.mjs`
maps this to `{ ok: false, seconds, status: 1, error: "execution error: ..." }`
(the `stderr.trim()` branch). What that error text looks like for a genuine
Mail.app domain error (a bad account or mailbox name) is deliberately out
of scope for this document - no probe in this task queried Mail with a bad
name, so this project has not yet measured that text; it is Task 13's
`research/probes/11-errors.js` and its error-taxonomy document.

The other half of the contract, and the reason it must never be relaxed:
**a status-0 exit does not imply the stdout is JSON.** Verified:

```
$ osascript -l JavaScript -e 'function run(){ return "not json"; }'
not json
$ echo $?
0
```

`osascript` exited 0 (JXA had no error - returning a plain string is not a
JXA-level failure) with stdout that is not valid JSON. If a probe author
forgets to `JSON.stringify` the return value, this is what running it
looks like: a clean exit with garbage on stdout that could be mistaken for
a successful, if oddly-shaped, result. `research/harness.mjs`'s third
branch exists for exactly this: `JSON.parse` throws, and the harness
reports `ok: false` with a truncated preview of the offending stdout,
rather than passing the raw string through as if it were data. Any leniency
here (guessing at a string result, wrapping it, best-effort recovery) would
turn a probe-authoring mistake into a silently wrong "successful" reading.

A subtlety worth stating plainly because it is easy to miss: the three
failure branches in `research/harness.mjs` are not equally distinguishable
from each other. See section 4 for why `result.error`-based failures in
particular - which cover more than the "spawn never happened" case the
message text ("spawn failed: ...") suggests - currently collapse into one
shape.

## 4. Buffer limits: why 64 MB

Node's `spawnSync`/`execSync` default `maxBuffer` is 1 MB. Exceeding it
kills the child and sets `result.error` with code `ENOBUFS`.

**Verified.** Rather than assert how common a message over 1 MB is,
`research/probes/12-message-sizes.js` bulk-fetches `messageSize()` (a
Mail-reported size in bytes) for an entire mailbox and reduces it to a
distribution. That bulk fetch - all 17,486 `messageSize` values - completed
in 2.064 seconds (`research/results/12-message-sizes.json`, `seconds`
field), which is only consistent with a small, constant number of Apple
Events, not one per message: 17,486 separate round trips into Mail.app
could not finish in two seconds at any plausible per-event cost.
`[unverified]` whether the true count is exactly one - a wall-clock figure
alone cannot distinguish "one Apple Event" from "a handful" - a later
document in this archive (`05-search.md`) measures bulk-fetch cost per
property directly and can state the exact count. Recorded against the
largest enabled account's INBOX (`messageCount` 17,486;
`research/results/12-message-sizes.json`):

| Statistic | Value |
|---|---|
| Message count | 17,486 |
| Median size | 8,077 bytes (about 8 KB) |
| Maximum size | 26,711,953 bytes (about 25.5 MB) |
| Over 1 MB | 138 (0.79%) |
| Over 4 MB | 30 (0.17%) |
| Over 16 MB | 7 (0.04%) |
| Over 64 MB | 0 |

This does not support "routinely exceed 1 MB" as a description of this
mailbox: the typical message is about 8 KB, and fewer than one message in a
hundred exceeds 1 MB. The honest framing the data supports is the opposite
one - **large messages are rare, not routine, on this mailbox** - but the
buffer still has to be raised anyway, for a different reason than
frequency: rare is not the same as bounded. 138 messages already exceed
1 MB on a single mailbox on this machine, and the maximum observed is 26.7
MB, comfortably inside a 64 MB cap and comfortably past a 1 MB one. A
`search`/`list` operation that touches this mailbox will eventually walk
into one of those 138 (or one of the 7 past 16 MB), and at that point it
does not matter that they are rare - the operation either has enough buffer
headroom to read that one message or it fails with `ENOBUFS`, in exactly
the misleading way described below. Sizing the buffer for the rare-but-real
maximum, not the common case, is the correct call precisely because the
common case was never the risk.

`[unverified]` - mined from upstream, not reproduced here - for the parts
of upstream's own reasoning this project has not independently measured:
whether a 20 MB attachment is something upstream's users actually hit in
practice (as opposed to anticipated it), and the exact "message not found" /
"attachment not found" symptom text upstream reports resulted from the
1 MB default. Upstream's own comment on why 64 MB specifically:

> "Mail operations routinely exceed 1 MB - `getRawSource` reads the entire
> raw MIME (a 20 MB attachment is explicitly anticipated), `getMessageContent`
> returns the full source, and large `search`/`list` result sets accumulate
> - so the default silently breaks exactly the large / attachment-bearing
> messages where it matters most (issue #27). Default to 64 MB; override
> with `APPLE_MAIL_MCP_MAX_BUFFER` (bytes)."
> (`src/utils/applescript.ts` lines 24-30)

Upstream's changelog entry for the same issue names the failure mode: the
1 MB default "broke exactly the large / attachment-bearing operations where
it mattered ... all appearing as 'message not found' / 'attachment not
found' / missing body" - a buffer overflow three layers down surfaced to
the end user as a completely unrelated-sounding error, because the caller
converted any transport failure into `null` and `null` was already the
"not found" sentinel. This project's own `research/harness.mjs` adopts the
identical 64 MB figure and the identical reasoning, verbatim in its own
comment (line 12-14), without re-deriving it.

**Verified**, the mechanism generically (plain Node `child_process`, no
Mail involved - reproduced directly rather than trusting the docs):

```
$ node -e '
const { spawnSync } = require("node:child_process");
const r = spawnSync("node", ["-e", "process.stdout.write(\"x\".repeat(2000000))"],
  { maxBuffer: 1000000, encoding: "utf8", killSignal: "SIGKILL" });
console.log(JSON.stringify({ error: r.error && { message: r.error.message, code: r.error.code },
  status: r.status, signal: r.signal }));
'
{"error":{"message":"spawnSync node ENOBUFS","code":"ENOBUFS"},"status":null,"signal":"SIGKILL"}
```

`result.error` is set, `result.status` is `null` (the child never got to
exit normally), and `result.signal` is whichever `killSignal` was
configured - `SIGKILL` here because that is what this project's harness
(and upstream) always configure, not because `ENOBUFS` implies it. This
matters because `research/harness.mjs`'s very first check is
`if (result.error) return { ok: false, ..., error: "spawn failed: ${result.error.message}" }`
- a buffer overflow never reaches the `status`-based branch at all, and is
reported with the same `"spawn failed: ..."` wording as two other, genuinely
different failure conditions. **Verified** - the same technique as the
`ENOBUFS` command above, applied to a missing binary and a timeout:

```
$ node -e '
const { spawnSync } = require("node:child_process");
const enoent = spawnSync("this-binary-does-not-exist-xyz", [], { killSignal: "SIGKILL" });
const timeout = spawnSync("sleep", ["5"], { timeout: 300, killSignal: "SIGKILL" });
const fmt = (r) => ({ error: r.error && { message: r.error.message, code: r.error.code }, status: r.status, signal: r.signal });
console.log(JSON.stringify({ enoent: fmt(enoent), timeout: fmt(timeout) }));
'
{"enoent":{"error":{"message":"spawnSync this-binary-does-not-exist-xyz ENOENT","code":"ENOENT"},"status":null,"signal":null},
 "timeout":{"error":{"message":"spawnSync sleep ETIMEDOUT","code":"ETIMEDOUT"},"status":null,"signal":"SIGKILL"}}
```

| Condition | Trigger | `result.error.message` (tail) | `result.status` | `result.signal` | `research/harness.mjs`'s returned `error` |
|---|---|---|---|---|---|
| `osascript` not found / not executable | `spawnSync` cannot create the child at all | `... ENOENT` | `null` | `null` | `spawn failed: spawnSync osascript ENOENT` |
| Process ran past `timeoutMs` | Node kills the child with `killSignal` once the timeout fires | `... ETIMEDOUT` | `null` | `SIGKILL` | `spawn failed: spawnSync osascript ETIMEDOUT` |
| stdout+stderr exceeded `maxBuffer` | Node kills the child and reports the overflow | `... ENOBUFS` | `null` | `SIGKILL` | `spawn failed: spawnSync osascript ENOBUFS` |

Three causes that have nothing in common - a binary that was never found, a
process that ran and was deliberately killed for taking too long, and a
process that ran and was deliberately killed for producing too much output
- all reach `research/harness.mjs` through the exact same `result.error`
branch and the exact same `"spawn failed: ..."` template. The word "spawn"
is actively wrong for the second and third rows (the process did spawn; it
was killed later, mid-run, possibly after dispatching work into Mail.app -
see section 6 on why that matters). The only thing distinguishing the three
today is the tail of a free-text string that happens to contain Node's own
error code, which nothing in `research/harness.mjs` or its callers
(`record.mjs`, `verify.mjs`) currently reads - they print the string as
given. This is the harness-level half of the conflation the brief for this
task named as a known, deferred finding (the other half being that this
same collapse is what makes a wedged-osascript timeout read as indistinguishable
from osascript never having launched); fixing it - adding a dedicated
`kind`/`code` field instead of one flat string - is future work, not done
by this document.

## 5. Timeouts, two levels

The pattern upstream converged on, `[unverified]` here except where this
project's own harness is noted as matching or diverging from it:

1. **An in-script deadline**, set a few seconds *below* the outer process
   timeout, so Mail.app's own AppleScript/Apple Event dispatch aborts the
   operation from inside itself.
2. **An outer process timeout**, `SIGKILL`, as the backstop if level 1
   somehow doesn't fire.

Upstream implements level 1 by wrapping every AppleScript body in a
`with timeout of N seconds ... end timeout` block, with `N` computed as the
outer timeout minus a fixed headroom:

```typescript
const SCRIPT_TIMEOUT_HEADROOM_MS = 5000;
// "The script-level timeout must fire *first* so Mail.app aborts the
// operation from inside its own AppleScript dispatch - cleanly releasing
// the event queue - before Node SIGKILLs the osascript process. Killing
// osascript alone does not stop work already dispatched into Mail.app,
// which is what wedges Mail.app for subsequent calls (issue #11)."
function wrapWithTimeout(script: string, processTimeoutMs: number): string {
  const seconds = Math.max(1, Math.ceil((processTimeoutMs - SCRIPT_TIMEOUT_HEADROOM_MS) / 1000));
  return `with timeout of ${seconds} seconds\n${script}\nend timeout`;
}
```

(`src/utils/applescript.ts` lines 102-128.) The ordering is the entire
point: killing the `osascript` *process* stops osascript from waiting on an
answer, but it does not reach into Mail.app and cancel whatever Apple Event
Mail.app is still in the middle of servicing. If that event never gets
told to give up, Mail.app's single dispatch thread (section 6) stays
occupied by it indefinitely, and every subsequent call - including ones
from a brand new, healthy `osascript` process - queues behind a slot that
will never free itself. The in-script timeout is what actually tells
Mail.app "stop"; the outer process timeout is only insurance for the case
where the in-script one fails to fire (a hung Apple Event Manager call that
does not honor AppleScript's own timeout is exactly such a case).

The outer level, level 2, is what `research/harness.mjs` implements today:

```js
const result = spawnSync("osascript", [...], {
  timeout: timeoutMs,
  // SIGKILL, not SIGTERM: a wedged osascript blocked on an unresponsive
  // Mail.app ignores SIGTERM, and piles up.
  killSignal: "SIGKILL",
  ...
});
```

**Why `SIGKILL` and not `SIGTERM`:** `SIGTERM` is a request a process can
ignore, and a process blocked inside a system call waiting on Mail.app's
Apple Event reply is exactly the kind of process that does. If `osascript`
ignores the request, the timeout has accomplished nothing - the process
that was supposed to be reaped is still there, still occupying whatever
this process was consuming, and the next timeout will pile another one on
top of it. `SIGKILL` cannot be ignored, so the process is guaranteed to be
reaped when the timeout fires. This still does not stop work already
dispatched into Mail (see the upstream quote above) - `SIGKILL` guarantees
osascript goes away, not that Mail.app's dispatch queue is released. That
second guarantee is what level 1 is for.

**What this project's harness does not yet do:** implement level 1.
`research/harness.mjs` has only the outer `SIGKILL` timeout, at a generous
default (`DEFAULT_TIMEOUT_MS = 120_000`, 120 seconds - versus upstream's
30-second default for a live MCP tool call) chosen because research probes
are trivial, individually-run reads with no client waiting on a strict
budget. None of the four probes recorded so far (`00-hello`,
`01-argv-modes`, `07-coldstart`, `12-message-sizes`, the slowest at 2.06s)
have come anywhere near either timeout.
This is a real gap, not an oversight to gloss over: a bulk fetch over a
large mailbox, or any future write operation, is exactly the kind of
long-running, genuinely-abortable-from-inside-Mail operation the two-level
pattern protects, and a server built from this archive should not skip
level 1 just because the research harness did. `[unverified]` whether JXA
has a direct syntactic equivalent to AppleScript's `with timeout of N
seconds ... end timeout` block (that exact keyword is AppleScript grammar,
not JavaScript) - JXA applications are commonly documented as exposing an
analogous `app.timeout = <seconds>` property inherited from the Standard
Suite, but this project has not probed it, and it should be verified with a
real probe before a future task relies on it.

## 6. The single-threaded dispatch queue

`[unverified]` in full - no probe in this project has issued concurrent
calls against Mail.app, so nothing here is this project's own measurement.
It is included because every later document that talks about serving
multiple MCP tool calls depends on knowing it.

Mail.app services Apple Events - the mechanism behind every AppleScript
and JXA call - on a single dispatch thread. Two `osascript` processes
calling into Mail.app at the same time do not run concurrently inside
Mail.app; the second call's event sits in a queue until the first one's
event finishes. Concurrency at the OS process level (multiple `osascript`
processes existing simultaneously) does not translate into concurrency at
the Mail.app service level.

The consequence is a cost staircase, not a cost ceiling: N concurrent calls
cost roughly N times one call's solo cost, because they are served one at a
time, while each caller is still counting its own wall clock from when it
made the call - including however long it spent waiting for a slot.
Upstream hit this directly and fixed it by serializing every Mail-touching
call in-process, through a single promise chain (`src/utils/serialize.ts`),
so that from Mail.app's perspective only one Apple Event is ever
outstanding regardless of how many client requests arrived concurrently:

> "Concurrent tool calls cascaded into 30s timeouts and left Mail.app
> wedged - parallel `tell application "Mail"` dispatches pile up inside
> Mail.app's single-threaded AppleScript handler; once enough stack up the
> later calls blow past their timeouts while earlier ones are still
> draining ... Mail-touching tool calls now run through a serial execution
> gate ... that chains every task through a single promise with a 50ms
> settle delay, so only one AppleScript runs at a time and Mail.app's
> dispatch queue never piles up." (CHANGELOG.md, issue #11)

Serializing the dispatch is necessary but not sufficient on its own:
upstream then shipped three further, increasingly specific fixes (issues
#135, #140, #142) because bounding *each call's own execution* to a
deadline still leaves the *wait to become the running call* unbounded and
invisible. Their own measurement, three concurrent unscoped `get-mail-stats`
calls against three real IMAP accounts: **5.5s / 10.3s / 15.6s** - a clean
1x/2x/3x staircase over a roughly 5.2s solo cost - and, separately, a
user's report of batches of 3 and 5 concurrent calls taking roughly 74s and
123s, both close to N times the single-call cost. The fix that finally
addressed it stamps each call's arrival time *before* the serialization
gate, not at the top of the handler's own code, and charges the wait
against the same deadline the work itself is charged against - because a
deadline that starts counting only once the handler begins running can
watch its own execution end cleanly while the caller, who has been waiting
since before the gate, has already timed out.

The design lesson for a server built from this archive: serialize
Mail-touching calls in-process (so Mail.app's own queue never has more than
one outstanding event from this process), and if any call is bounded by a
caller-facing deadline, start that deadline's clock at the moment the call
arrived, not at the moment it started running.

## 7. Cold start versus warm

An earlier ad-hoc measurement, recorded in this project's design spec
(`docs/superpowers/specs/2026-08-11-mail-mcp-design.md`, section 3.4)
before this archive existed, reported the first `osascript` call after
Mail.app had been idle taking **6.80s**, with subsequent identical calls
taking **0.15s**. This task attempted to reproduce that figure properly and
could not: Mail.app on this machine has been running continuously for over
three days (`ps` shows the process started `Sat Aug 8 09:48:34`, current
time `Tue Aug 11 16:13`), and this task's global constraints forbid quitting
or restarting the user's Mail.app to force a genuinely cold state. There is
no other known way to make Mail.app's scripting bridge cold without ending
its process. The 6.80s figure is therefore carried forward as
**`[unverified, from an earlier ad-hoc measurement]`** - it is not
reproduced by anything in `research/results/`, and should not be treated as
this archive's own finding until a future task can measure it honestly
(for example: with the user's explicit, informed, one-off consent to quit
and relaunch Mail.app for this specific measurement, or opportunistically,
by having a warm-up probe log its own timing to a file across whatever
Mail.app restart happens next - a reboot, a macOS update, the user quitting
it themselves - and collecting that log later).

What this task **did** measure, honestly, against the long-warm Mail.app
that was actually available (`research/probes/07-coldstart.js`, recorded as
`research/results/07-coldstart.json`): five successive
`Mail.accounts.name()` calls inside one already-running JXA process -

```
inProcessRoundTrips: [0.137, 0.012, 0.040, 0.001, 0.009]  // seconds
```

- and, separately, three brand-new `osascript` processes in a row, each its
own fresh spawn, each making the same trivial call (`00-hello`, three
independent runs of `research/harness.mjs`'s `runProbe`):

```
0.21s
0.18s
0.16s
```

Neither shows anything resembling a 6.80s cliff. The first in-process call
(0.137s) is the largest of its five, but by a small margin, not an order of
magnitude, and the three fresh-process runs are all close to each other
with no dramatic first-call penalty at all. This is consistent with, and
extends, Task 1's finding that the ~7s figure is conditioned on Mail.app's
*process* being freshly launched (or its Apple Event handling not yet
initialized since launch), not on a script having been idle for a while, or
on the calling process being new: once Mail.app has serviced any Apple
Event at all since its own process started, both repeat in-process calls
and brand-new external `osascript` processes measure cheap.

The implication upstream drew still stands as sound design advice
regardless of whether the specific number is confirmed: if a true
first-Apple-Event-of-Mail's-process-lifetime cost of several seconds is
real, a server built from this archive should fire one cheap warm-up probe
(exactly the trivial call `research/probes/07-coldstart.js` makes) once at
its own startup, so that cost - whatever it turns out to be - is paid
before a real user request arrives to pay for it, not during one.

## 8. Retry: which failures are transient

`[unverified]` in full - mined from `src/utils/applescript.ts`, never
executed here. No probe in this project has triggered a real Mail.app
failure and observed whether or how a retry behaves.

Upstream's retry policy is opt-in, easy to miss on a first read:
`DEFAULT_MAX_RETRIES = 1`, and the retry loop is `for (let attempt = 1;
attempt <= maxRetries; attempt++)` (`applescript.ts` line 387) - with the
default, that loop runs exactly once. No retry happens unless a caller
explicitly raises
`maxRetries` (upstream's own comment suggests `3`, giving exponential
backoff at 1s/2s). Whether to retry at all, when enabled, is decided purely
by matching the error *text* against a fixed list of patterns:

```typescript
const RETRYABLE_ERROR_PATTERNS = [
  /timed? out/i,
  /not responding/i,
  /connection.*invalid/i,
  /lost connection/i,
  /busy/i,
];
```

(`src/utils/applescript.ts` lines 157-163, plus `isTimeoutError` treating
any `SIGTERM`/`SIGKILL`-killed `osascript` as a timeout regardless of
message text.) The distinction that matters is not "did the call fail" but
*why*:

| Failure | Retry? | Reasoning |
|---|---|---|
| Timed out | Yes | Mail was slow or wedged this one time; a fresh attempt has a real chance of finding it responsive |
| "not responding" | Yes | Mail.app itself was momentarily unresponsive (e.g. relaunching) - a property of that moment, not of the request |
| "connection is invalid" / "lost connection" | Yes | Mail.app crashed or restarted mid-call; a fresh Apple Event connection on retry may succeed where the stale one couldn't |
| "busy" | Yes | Dispatch-queue contention (section 6) - the same request will likely succeed once the queue drains |
| Can't get account/mailbox "X" | No | The name is genuinely wrong. Retrying re-asks Mail.app the identical question and gets the identical answer, just slower and after a backoff delay |
| Not authorized / permission denied | No | Automation access has not been granted. No amount of retrying changes that outcome; only the user granting access does |
| Syntax error | No | A bug in the generated script. Retrying re-executes the same broken code |

Retrying a domain failure (the bottom three rows) is worse than doing
nothing: it does not merely fail to help, it burns the backoff delay
(1s, then 2s, ...) and returns the *same* wrong answer later instead of the
same wrong answer immediately, which is strictly worse for anything waiting
on a response. Retrying a transient failure (the top four rows) is what
gives a single blip in Mail.app's responsiveness a chance to resolve itself
without surfacing as a hard error to whatever is calling the tool.

One implementation detail worth flagging rather than repeating verbatim:
upstream's backoff sleep between attempts is `spawnSync("sleep", [...])` -
a *blocking* OS-level sleep, not a `setTimeout`/`Promise` delay - because
`executeAppleScript` is fully synchronous end to end, matching upstream's
synchronous MCP tool handlers. `[unverified]` whether a server built from
this archive should keep that choice: a synchronous sleep blocks the
entire Node process for its duration, which is a real cost of a
fully-synchronous design (nothing else that process is doing progresses
either), not merely an implementation curiosity.

## Sources

- `research/harness.mjs` (this repository) - the harness whose contract
  sections 2-5 describe directly.
- `research/probes/00-hello.js`, `01-argv-modes.js`, `07-coldstart.js`,
  `12-message-sizes.js` and their recordings in `research/results/` - every
  claim in this document marked verified without a separately quoted
  command is backed by one of these four recordings.
- `.superpowers/sdd/2026-08-11-apple-mail-knowledge-archive/task-1-report.md`
  - the argv-fidelity and file-mode-vs-`-e` verification this document
    quotes verbatim rather than re-deriving.
- `docs/superpowers/specs/2026-08-11-mail-mcp-design.md`, section 3.4 - the
  origin of the 6.80s cold-start figure this document could not reproduce.
- `../apple-mail-mcp/src/utils/applescript.ts` -
  every `[unverified]` claim about shell escaping, timeouts, buffer limits
  and retry policy. Read-only; no code copied.
- `../apple-mail-mcp/CHANGELOG.md` - issues #11,
  #27, #135, #140, #142, for the dispatch-queue and buffer-limit bug
  history cited in sections 4 and 6.
