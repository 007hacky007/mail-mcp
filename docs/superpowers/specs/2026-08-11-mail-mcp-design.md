# mail-mcp: design

Date: 2026-08-11
Status: approved, ready for implementation planning

## 1. Purpose

Build an Apple Mail MCP server from scratch, owned end to end, with a supply chain
small enough to read in an afternoon. Email is the most sensitive data on the
machine and an MCP server for it holds unrestricted read access to all of it, so
"I trust this because I read all of it" is the only acceptable trust story.

A second, equal goal: preserve the hard-won knowledge about how Mail.app scripting
actually behaves, so this is never researched from scratch again. That knowledge is
currently spread across a 4411-line service file, a 119KB changelog and a set of
GitHub issues in a third-party repository (`sweetrb/apple-mail-mcp`, MIT). The
archive in `docs/apple-mail/` is a first-class deliverable, not documentation of
the code.

### Relationship to the upstream project

Upstream is the research input, not the codebase to fork. Nothing is copied. Where
upstream reached a conclusion the hard way, the archive records the conclusion and
what it cost. Where upstream is wrong or was made obsolete by a better approach
(see section 3), the archive says so and why. Upstream is MIT licensed, so
incorporating its findings as documented knowledge is unencumbered; this project
carries its own license and no derived code.

## 2. Scope

### In scope for v1

Reading mail, listing structure, reading attachments, diagnostics, and creating
drafts. Thirteen tools, enumerated in section 6.

### Out of scope for v1, deliberately

Each of these is a decision, not an oversight.

| Excluded | Reason |
|----------|--------|
| Sending mail, in any form | See section 8.1. No code path transmits mail. |
| `delete-message`, `delete-mailbox` | Destructive. Not needed for v1. |
| `move-message`, batch move | Destination resolution is genuinely hard to get right and a wrong destination scatters mail. Deferred until needed. |
| `mark-as-read` / `unread`, `flag` / `unflag` | Reversible and low risk, but not needed for v1. Cheap to add later. |
| Mail rules (list/create/enable/disable/delete) | Not needed. Upstream's approach is recorded in the archive. |
| Email templates | Not needed. Ordinary file storage, no Mail.app knowledge involved. |
| Smart mailboxes | Requires editing `SyncedSmartMailboxes.plist` directly. High blast radius, not needed. |
| `create-mailbox`, `rename-mailbox` | Mutates folder structure. Not needed. |
| Contacts lookup | Needs Full Disk Access for the whole process, a broad grant for a small feature. |
| Serial email / mail merge | Moot: sending is out of scope. |
| Direct IMAP backend | Would require app passwords in the Keychain and outbound sockets. Section 3 shows it is also unnecessary for speed. |
| Direct SMTP backend | Moot: sending is out of scope. |
| IMAP IDLE push notifications | Requires a persistent connection per account. Moot without IMAP. |

The archive documents how upstream implemented the ones worth revisiting, so
adding any of them later is a reading exercise rather than a research exercise.

## 3. Verified findings

Measured on this machine on 2026-08-11 against a real Mail.app: five configured
accounts (two enabled, three disabled), the largest enabled account having 32
mailboxes and an INBOX of 17,484 messages. These numbers are the empirical basis
for the architecture and are reproduced in `docs/apple-mail/10-measurements.md`
with the exact scripts used.

### 3.1 JXA replaces AppleScript

`osascript -l JavaScript` drives Mail.app fully, returns `JSON.stringify` output,
and accepts values through `argv`. This collapses three of upstream's hardest
problems at once:

| Upstream problem | JXA answer |
|------------------|------------|
| Two hand-escaped layers: shell single-quoting plus AppleScript string literals | Values arrive via `argv`. Zero escaping. Verified: `"` and `\` and `\\` survive intact. |
| A hand-rolled delimiter protocol using ASCII control characters (`\x1f` field, `\x1e` record, `\x1d` marker) that still corrupts if a value contains one | `JSON.stringify`. Structurally cannot collide. |
| A `repeat` loop per message. 47s to read the newest 20 of a 44k mailbox, which is what drove upstream to build an entire IMAP backend. | Bulk property arrays. About 1s per property per 17k messages. |

### 3.2 Bulk property fetch is the whole performance story

In JXA, `mailbox.messages.subject()` is **one** Apple Event that returns an array
of every subject. It is not N events. Measured over the 17,484-message INBOX:

| Operation | Time |
|-----------|------|
| bulk fetch `id[]` | 0.71s |
| bulk fetch `subject[]` | 1.05s |
| bulk fetch `sender[]` | 0.89s |
| bulk fetch `dateReceived[]` | 0.90s |
| bulk fetch `readStatus[]` | 0.97s |
| all five, total | 4.52s |
| filter 17,484 subjects in JS | 0.003s |
| total wall clock including process spawn | 5.19s |

So a substring search across 17k messages costs about 5 seconds, entirely locally,
with no credentials and no network. A subject-only search needs just `id[]` and
`subject[]`, about 1.8s.

`id` comes back as a JavaScript number (for example `597345`). `dateReceived`
comes back as a real JavaScript `Date`.

### 3.3 The `whose` clause is a trap

Pushing the filter into Mail is dramatically slower than pulling the data out and
filtering in JS:

| Approach, same 19 results | Time |
|---------------------------|------|
| `messages.whose({subject: {_contains: "invoice"}})` then fetch matches | 27.85s |
| bulk fetch 5 properties, filter in JS | 5.19s |

Upstream uses `whose` clauses throughout. That single choice is most of their
slowness, and most of the reason the IMAP backend exists.

Nuance to record in the archive: this measurement is for a `_contains` comparison,
which appears to cost a round trip per message inside Mail. Equality on an indexed
property may behave differently. It does not matter for this design, because
identity lookups are served from bulk-fetched `id[]` arrays anyway.

### 3.4 Cold start costs 6.8s, warm calls cost 0.15s

The first `osascript` call after Mail.app has been idle took 6.80s. Subsequent
identical calls took 0.15s. The gap is Mail.app's scripting bridge warming up, not
our script. Implication: fire a cheap warm-up probe at server startup so the first
real tool call a user makes is not the one that pays for it.

### 3.5 Mail's errors are useless, so validate first

A bad account name produces exactly this on stderr, with exit status 1:

```
execution error: Error: Error: Can't get object. (-1728)
```

There is no indication of *which* object. This cannot be turned into a helpful
message after the fact, so names must be validated against enumerated lists
*before* use. That is invariant 7 in section 5.

### 3.6 File-mode `argv` includes the `--` separator

With `-e`, `osascript -e '...' -- foo` yields `argv == ["foo"]`. With a script
file, `osascript -l JavaScript script.js -- foo` yields `argv == ["--", "foo"]`.
Either strip the leading `--` or do not pass it in file mode. Verified both ways.

## 4. Architecture

TypeScript on Node 20+, **zero runtime dependencies**. No MCP SDK, no zod. Dev
dependencies (`typescript`, `vitest`) are audited once and never shipped.

```
mcp/          stdio JSON-RPC: initialize, tools/list, tools/call    (~200 lines, 0 deps)
   |
tools/        one file per tool: validate input -> call mail op -> shape output
   |
mail/         domain ops: accounts, mailboxes, messages, search, drafts, attachments
   |
jxa/          runner + one .js script per operation, shipped as readable files
   |          spawn (NO shell): osascript -l JavaScript jxa/<op>.js <args...>
Mail.app
```

### 4.1 Layer responsibilities

**`mcp/`** implements only what a stdio MCP server needs: newline-delimited
JSON-RPC framing on stdin/stdout, the `initialize` handshake, `tools/list`, and
`tools/call`. No resources, no prompts, no sampling. Nothing in this layer knows
what mail is. It is the layer most worth keeping small, because it is the one
parsing untrusted-shaped input from the host.

**`tools/`** holds one file per tool. Each file owns its input schema (as a plain
JSON Schema literal for `tools/list`), a hand-written validation guard, the call
into `mail/`, and the output shaping. A tool file never builds a script and never
spawns a process.

**`mail/`** holds the domain operations. This layer decides *which* script to run
and *what* the arguments are, and it owns the semantics: what "the inbox" means on
a Gmail account, how a thread is grouped, which properties a given tool needs.
It never constructs script text.

**`jxa/`** holds the runner plus the scripts themselves as ordinary `.js` files.
The runner owns process spawning, the serialization queue, timeouts, and turning a
non-zero exit into a typed error. Each script is independently runnable from a
terminal, which is what makes them auditable and debuggable.

### 4.2 Why scripts are files rather than template strings

A `.js` file can be run by hand, diffed, syntax-checked by the editor, and read
without mentally un-escaping a template literal. It also makes invariant 2
structurally true rather than merely intended: there is no string concatenation
site where a value could be spliced into code, because the code is on disk and the
values arrive as `argv`.

The tradeoff is that the package ships a directory of scripts rather than one
bundled file. That is acceptable and arguably better for auditability. Resolution
of the script directory must be robust to how the server is launched, and must not
depend on the process working directory.

## 5. Invariants

These are the load-bearing rules. Each exists because of something concrete.

1. **No shell, ever.** `spawn("osascript", [...])` with an argv array. Upstream
   builds `osascript -e '<script>'` as a shell string and hand-escapes single
   quotes, which is one missed edge case away from arbitrary command execution
   with full access to the user's mail.

2. **No user-supplied value is ever interpolated into script text.** Values reach
   scripts only through `argv`. Verified in 3.1.

3. **All script output is JSON on stdout, and nothing else.** Any non-JSON stdout
   is a bug, not a value to be parsed leniently. Scripts write diagnostics to
   stderr if at all.

4. **All `osascript` calls are serialized through one in-process queue.** Mail's
   AppleScript dispatch is single-threaded: concurrent calls do not overlap, they
   each pay full cost while holding the queue. Upstream discovered this late and
   bolted a queue onto a single tool. Build it into the runner, and charge queue
   wait against the caller's deadline so a request that waited out its own budget
   reports the queue as the cause rather than timing out mysteriously.

5. **Never use a `whose` clause with a comparison operator.** Bulk-fetch property
   arrays and filter in JS. 5.19s versus 27.85s, measured in 3.3.

6. **Bound every call twice, inner deadline first.** An in-script deadline set a
   few seconds *below* the outer process timeout, so Mail aborts the work from
   inside its own dispatch queue and releases it cleanly. Kill the outer process
   with `SIGKILL`, not `SIGTERM`: a wedged `osascript` blocked on an unresponsive
   Mail.app ignores `SIGTERM`, and killing `osascript` alone does not stop work
   already dispatched into Mail, which is what wedges Mail for every subsequent
   call.

7. **Validate names against enumerated lists before use.** Enumerate accounts and
   mailboxes, match, and produce our own error naming the real candidates. Mail's
   `-1728` cannot be recovered into a useful message (3.5).

8. **No module in the tree opens a network socket, and none is imported.** Verified
   by a test that greps the dependency closure, not by intent. See 8.1.

9. **Filesystem writes are confined to an allowlisted root.** Only
   `save-attachment` writes, only under a configured root, only after resolving
   symlinks. See 8.2.

## 6. Tool surface

Thirteen tools. Every tool takes an optional `account` and returns structured JSON.

### 6.1 Diagnostics

**`doctor`** reports: Mail.app running, Automation permission granted, accounts
visible, whether the Node binary is Developer-ID signed or ad-hoc, script
directory resolved, and a warm round-trip timing. This is the first thing to reach
for when anything else misbehaves, and it is cheap to build.

### 6.2 Structure

**`list-accounts`** returns name, enabled state, account type, and email
addresses per account. Disabled accounts must be reported as such rather than
silently omitted or treated as broken: this machine has three disabled accounts
with zero mailboxes, and upstream shipped a bug where a Mail-disabled account was
reported as an unreadable one.

**`list-mailboxes`** returns the mailbox tree with full paths, message counts, and
unread counts. Full path is mandatory in the output, because leaf names collide
across accounts and a leaf name alone is not a usable identifier.

**`get-unread-count`** takes an optional mailbox and returns a count. Mail caches
counts, so this is cheap. It exists specifically so that "how much unread mail do
I have" does not require the expensive path.

### 6.3 Reading

**`list-messages`** takes a mailbox and a limit, returns the newest N with id,
subject, sender, date, read state, and mailbox path. Implemented as a bulk fetch
plus a slice.

**`search-messages`** takes a query and optional field selectors, mailbox scope,
date range, and limit. Implemented as bulk fetch of only the properties the query
actually needs, then filter in JS. Must report which mailboxes it scanned and
which it skipped, so an empty result is never ambiguous between "nothing matched"
and "we gave up".

**`get-message`** returns full headers plus the plain-text body. `includeHtml` is
opt-in and is the only thing that fetches `source`. This is not a micro
optimization: upstream fetched `source` unconditionally and returned the entire
raw MIME blob, base64 attachments and all, mislabeled as the HTML body.

**`get-thread`** groups related messages. Grouping is by RFC `message-id` /
`references` where available and falls back to normalized subject. The fallback
must be visible in the output so the caller knows which grouping produced the
result.

### 6.4 Attachments

**`list-attachments`** returns name, MIME type, and size per attachment. Sourced
by parsing the message's MIME `source`, not from Mail's attachment objects, whose
reported names and types are less reliable.

**`save-attachment`** writes one attachment to a path under the allowlisted root.
There is deliberately no variant that returns attachment bytes into the
conversation: that path turns any message into a channel for pushing arbitrary
content at the model.

### 6.5 Drafts

All three land in Mail.app's Drafts folder. None of them transmits anything.

**`create-draft`** takes `to` / `cc` / `bcc` arrays, subject, body, and optional
absolute attachment paths. Uses `make new outgoing message` with
`visible: false`, sets recipients as child objects, and never calls `send`.

**`reply-draft`** takes a message id, a body, and optional `replyAll`. Uses
`reply ... without opening window` and saves. The `without opening window` form is
mandatory: with a compose window, `set content` silently no-ops because the window
is not ready yet, producing a reply with an empty body. This is upstream's issue
number 7, and no amount of `delay` fixes it reliably from a background process,
which is exactly how an MCP server runs.

**`forward-draft`** takes a message id and recipients, with an optional prepended
body. Uses `forward ... without opening window` and saves. Same reasoning.

### 6.6 Message identity

Mail's `id` is a per-mailbox integer, not a stable global identifier: it is not
preserved across a move, and it is meaningless without knowing the mailbox. Every
tool that returns messages therefore returns the full mailbox path alongside the
id, and every tool that accepts an id also accepts an optional account and mailbox
hint so lookup does not have to scan every mailbox of every account. Where an RFC
`message-id` exists it is returned too, as the only identifier that survives a
move. The archive documents this in full, because getting it wrong produces
intermittent "message not found" failures that are painful to diagnose.

## 7. The knowledge archive

`docs/apple-mail/`. Written to outlive the upstream repository. Every recipe is a
complete runnable snippet with its expected output shape, not a pointer into
someone else's file. Anything verified live on real hardware says so and carries
its timing; anything taken only from reading upstream's code is marked
`[unverified]`.

| File | Contents |
|------|----------|
| `00-overview.md` | How Mail.app scripting works at all: the Apple Event bridge, the single-threaded dispatch queue, what Mail exposes versus what it hides, AppleScript versus JXA versus ScriptingBridge, and why this project chose JXA. |
| `01-execution-model.md` | Invoking `osascript`: `-e` versus file mode, `argv` passing and the `--` discrepancy, exit codes, stdout/stderr split, output buffer limits, the two-level timeout, `SIGKILL` versus `SIGTERM`, cold start versus warm, and the serialization queue. |
| `02-escaping-and-injection.md` | The two escaping layers upstream had to hand-maintain, exactly how they fail, and how `argv` plus script files removes both. Kept even though this project does not need it, because it is the trap anyone rebuilding this will otherwise walk into. |
| `03-object-model.md` | `application` / `account` / `mailbox` / `message` / `outgoing message` / attachments. Every useful property with its real type and its cost class. Message identity semantics in full (see 6.6). Nesting and full-path resolution. |
| `04-reading-recipes.md` | Complete verified scripts for each read tool, with real output shapes and timings. |
| `05-search.md` | Why search is slow, the `whose` measurement, the bulk-fetch-and-filter pattern, which properties cost what, mailbox size guards, per-account budgets, and how to report partial results honestly. |
| `06-drafts.md` | `make new outgoing message`, recipients as child objects, attachments, the `without opening window` requirement for reply and forward, and the full table of approaches upstream tried that failed. |
| `07-attachments.md` | Mail's attachment objects versus parsing the MIME `source`, why the latter is more reliable, size and type extraction, encoded filename handling, and the "raw MIME returned as HTML" bug. |
| `08-quirks-and-traps.md` | Gmail's virtual INBOX (the literal `INBOX` holds roughly nothing; real mail lives in `All Mail` and `Important`, nested inside a `[Gmail]` container so a flat mailbox lookup does not find them). Mailbox name aliases across providers. Localized macOS. Unicode and emoji in subjects. AppleScript date construction. Disabled accounts. Ambiguous leaf names. |
| `09-permissions-and-tcc.md` | Automation versus Full Disk Access, what each unlocks, how to request and verify them, and the ad-hoc-signed-Node problem: a Homebrew Node's cdhash changes on every upgrade so TCC treats it as a new binary and re-prompts forever. Fix is an official Developer-ID-signed Node at a stable path. |
| `10-measurements.md` | The timing tables from section 3, the exact scripts that produced them, the hardware and mailbox sizes, and a re-run procedure. Every performance claim in the design traces here. |
| `11-upstream-bug-ledger.md` | The highest-value file. Every bug upstream hit, what it looked like, the root cause, and the fix. Mined from 119KB of changelog, the test suite, and referenced issues. Rebuilding without this means rediscovering each one in production. |
| `12-envelope-index.md` | The read-only SQLite alternative that was considered and rejected as a backend: schema sketch, what it buys, what it costs (Full Disk Access, private schema that Apple changes between releases). Documented as an escape hatch if JXA bulk-fetch ever stops being fast enough. Commits to nothing. |

## 8. Security model

### 8.1 No send path

The strongest available guarantee, and the reason drafts-only was chosen over a
token-gated send. A two-phase draft-then-send flow does not actually establish
human review: if the token is returned in the tool response, the model can chain
both calls in one turn and the human never looks. Making the token unforgeable
requires an out-of-band channel the model cannot read, which is real but intricate.

Removing the capability is simpler and stronger. The server has no code path that
transmits mail, which is verifiable by inspection rather than by reasoning about a
protocol. The user reviews the draft in Mail.app and presses Send.

Enforced by a test that walks the shipped dependency closure and fails if anything
imports `node:net`, `node:tls`, `node:http`, `node:https`, `node:dgram`, or
`fetch`. An intent stated in a comment is not an invariant; a failing test is.

### 8.2 Filesystem containment

`save-attachment` is the only writer. Its target must be an absolute path, must
resolve (after following symlinks) to a location under a configured allowlisted
root defaulting to the user's Downloads directory, and must not traverse out via
`..` or a symlinked parent. Attachment filenames from mail are untrusted input and
are sanitized before use, never passed through as-is.

### 8.3 No credentials, no network

There is nothing to steal. No app passwords, no Keychain entries, no OAuth tokens,
no sockets. Mail.app does its own syncing with its own credentials, which this
server never sees. This is the direct payoff of choosing AppleScript-only over an
IMAP backend, and it is worth more than the speed the IMAP backend was built to
buy, particularly given 3.2.

### 8.4 Prompt injection is the residual risk

This deserves stating plainly rather than being left implicit. Email content is
attacker-controlled: anyone can send mail containing text engineered to steer a
model that reads it. This server cannot prevent that, and no amount of hardening
inside it will.

What the design does is bound the damage. There is no send tool, so injected
instructions cannot cause mail to be transmitted. There is no delete or move, so
they cannot destroy or hide mail. There is no attachment-bytes-to-conversation
tool, so a message cannot push arbitrary content at the model. The worst outcome
from a malicious email is that the model is misled about what the mailbox
contains, which is bad but recoverable, and it is bounded by construction rather
than by a filter that has to be right every time.

The archive should note this explicitly as the reason the write surface is small,
so a future version that adds `move` or `delete` is making that tradeoff knowingly.

### 8.5 Permissions requested

Automation access to Mail.app, and nothing else. Full Disk Access is deliberately
not required, which is why contacts lookup was dropped and why the Envelope Index
backend stays a documented alternative rather than an implementation.

## 9. Error handling

Three failure classes, each surfaced distinctly, because collapsing them is how
upstream ended up reporting transport failures as empty results.

**Transport failure** means `osascript` exited abnormally, was killed, produced
non-JSON on stdout, or hit the buffer cap. This is never an empty answer. A search
that failed to run must not look identical to a search that found nothing. This
was a real upstream bug and it is the single most important distinction in this
section.

**Domain failure** means Mail answered and the answer is "no": account not found,
mailbox not found, message not found. These carry the enumerated candidates so the
caller can retry correctly instead of guessing, per invariant 7. An ambiguous
mailbox leaf name is refused with every candidate named, never resolved by
guessing.

**Partial success** means some accounts or mailboxes were reachable and some were
not, or a budget expired mid-scan. Totals from a partial result are floors, not
answers, and must be labeled as such along with what is missing. A tool that
returns a number a caller will treat as complete must be certain it is complete.

Retries apply only to genuinely transient patterns (timeout, not responding, lost
connection, busy) with backoff, and never to domain failures.

## 10. Testing

Almost none of this can run in CI, so the tiers are explicit about what each one
actually proves.

**Tier 1, unit, no Mail required.** Runs anywhere, including CI. Covers input
guards, JSON-RPC framing, output shaping, MIME parsing, path allowlisting and
traversal rejection, thread grouping, mailbox path resolution and ambiguity
refusal, error classification, and the no-network dependency-closure check. This
is the bulk of the test suite and the only tier that gates a commit.

**Tier 2, JXA contract tests, real Mail, read-only.** Runs each script against
the real Mail.app and asserts the *shape* of the returned JSON, not its contents,
since contents are personal and vary. This tier is what catches a macOS update
changing the object model. Opt-in via env var, documented as requiring a real
Mail.app with at least one enabled account.

**Tier 3, drafts, manual by default.** Draft creation is the only mutation, and
automating it litters the user's real Drafts folder. It gets a documented manual
checklist covering unicode bodies, attachments, reply threading, reply-all, and
forward, plus an opt-in automated version guarded by an explicit env var for
anyone willing to clean up after it.

Performance claims get a re-run script rather than assertions. Timings vary by
machine and mailbox size, so a hard threshold would be a flaky test; the script
regenerates `10-measurements.md` instead.

## 11. Risks and open questions

**JXA is less documented than AppleScript.** Fewer examples exist, and the
Mail.app dictionary is written in AppleScript terms that have to be translated.
Mitigated by section 3 having already verified the load-bearing operations, and by
the archive recording the translations as they are established.

**Bulk fetch on a very large mailbox is unmeasured.** 17,484 messages cost 4.5s
for five properties. A 100k-message mailbox is presumably linear at roughly 25s,
but that is extrapolation, not measurement. Measuring it belongs in the
implementation plan, and a per-mailbox size guard with honest partial reporting is
in the design regardless.

**Memory on bulk fetch is unmeasured.** Pulling five arrays of 17k strings into
the JXA process is clearly fine. At 500k messages it may not be. Chunking by
message index range is the fallback and should be sketched in the archive.

**macOS updates can change the object model.** This is the standing risk for
anything built on Apple Events. Tier 2 contract tests are the detector.

**Script directory resolution across launch contexts.** The server may be launched
by different hosts with different working directories. Resolution must be based on
the module's own location, and this needs a test.

## 12. Deliverables

1. `docs/apple-mail/` complete, thirteen files per section 7, with verified
   findings marked as verified and everything else marked `[unverified]`.
2. The server implementing the thirteen tools of section 6, zero runtime
   dependencies, honoring the nine invariants of section 5.
3. Tier 1 tests green, including the no-network closure check. Tier 2 present and
   documented. Tier 3 checklist written.
4. A README covering install, the official-signed-Node recommendation, the
   Automation permission grant, and the drafts-only security posture stated
   plainly enough that a future contributor does not casually add a send tool.
