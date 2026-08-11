# Apple Mail knowledge archive

What is known, verified, and still open about driving Mail.app from a script.
Written so the server in this repo can be built from these files alone.

## Status: partial, deliberately stopped

Extraction was stopped on 2026-08-11 after the two highest-value documents were
finished, because the remaining planned documents were either JXA code that the
implementation writes anyway, or notes that would have shipped `[unverified]`.
The full extraction plan is preserved at
`docs/superpowers/plans/2026-08-11-apple-mail-knowledge-archive.md` if any of it
is ever wanted.

| Document | Status |
|----------|--------|
| `01-execution-model.md` | Done. Invocation, argv, no-shell, buffer limits, two-level timeout, dispatch queue, cold start, retry, error taxonomy. |
| `03-object-model.md` | Done. Property tables with real types and cost classes, message identity, disabled accounts. |
| `02-escaping-and-injection.md` | Not written. Argument passing removes the problem entirely; see `01-execution-model.md` section 2. |
| `04-reading-recipes.md` | Not written. The recipes are the server's `jxa/*.js` files; writing them twice was the reason to stop. |
| `05-search.md` | Not written. Its findings are in "Verified findings" below and in the design spec section 3. |
| `06-drafts.md` | Not written. Would have been entirely `[unverified]`, since the extraction plan forbade writes. The implementation must verify these recipes itself. |
| `07-attachments.md` | Not written. Standard MIME parsing plus the one trap recorded below. |
| `08-quirks-and-traps.md` | Not written, but see the Gmail contradiction below, which is unresolved and matters. |
| `09-permissions-and-tcc.md` | Not written. Belongs in the README when the server ships. |
| `10-measurements.md` | Not written. `research/results/*.json` are the measurements, and `node research/verify.mjs` re-runs them. |
| `11-upstream-bug-ledger.md` | Not written. The load-bearing entries are in the design spec's error-handling section and in `01-execution-model.md`. |
| `12-envelope-index.md` | Not written. Rejected as a backend; needs Full Disk Access. |

## The reusable infrastructure

`research/` is not scaffolding, it is the drift detector, and it carries forward
as the server's contract-test layer:

```bash
npm test                  # 126 tests, zero osascript calls, runs anywhere
node research/verify.mjs  # re-runs every probe against real Mail, ~30s
```

`verify.mjs` fails when a macOS update changes Mail's object model. It compares
a structural fingerprint AND a success profile (every status-flag path and its
value), because a fingerprint alone cannot see a single property going
unavailable: `true` and `false` are both `boolean`.

Adding a probe field requires declaring its key, lowercased, in
`STRUCTURAL_KEY_NAMES` in `research/redact.mjs`. That friction is deliberate.
Probe arguments must be non-personal by construction: position 0 is an account
selector (`0`, `largest-enabled`, `gmail-style`), later positions must be a
standard mailbox name.

## Verified findings

Every figure here traces to a committed recording in `research/results/`.
Measured on this machine, 2026-08-11.

**Bulk property fetch is the whole performance story.** `mailbox.messages.subject()`
is a small constant number of Apple Events returning an array, not one per
message. 17,486 values in about 1s per property.

**Never use a `whose` clause with a comparison operator.** The same 19 results:
27.85s via `whose({subject:{_contains:...}})` versus 5.19s via bulk fetch plus a
JS filter. This is most of upstream's slowness and the entire reason its IMAP
backend exists.

**Property cost is uniform, not per-property.** All 17 message properties cost
0.48s to 3.2s each when reached via `messages[0]` on a 17,486-message mailbox.
`source` was not the outlier at 0.735s. The same probe on a 3-message mailbox:
8ms to 68ms for everything. So cost tracks the reach pattern into a large
collection, not the property. Reading one property of one message from a big
mailbox costs roughly what reading all of them costs.

**Scaling is worse than linear in both reach patterns.** On a 52,143-message
account, single-index message access did not complete within 240s, and bulk fetch
degraded to 40-53s. A per-mailbox size guard is mandatory, not optional.

**Message sizes** across 17,486 messages: median 8,077 bytes, largest
26,711,953 bytes, 138 over 1 MB, 30 over 4 MB, 7 over 16 MB, none over 64 MB. So
Node's 1 MB default `maxBuffer` would fail 138 times here, and 64 MB is
empirically sufficient. Large messages are rare but unbounded.

**Disabled accounts raise on nothing.** All seven probed account properties
return normally; the only signal is `enabled: false` with `mailboxCount: 0`. A
tool must distinguish "switched off" from "unreadable".

**`argv` needs no escaping.** Quotes, backslashes and spaces survive intact
through `spawnSync` with an argv array plus `osascript` file mode. In file mode
`argv` includes the `--` separator; with `-e` it does not.

**Mail's errors name no object.** A bad account yields
`execution error: Error: Error: Can't get object. (-1728)` on stderr, exit 1.
Validate names against enumerated lists first, because this cannot be recovered
into a useful message afterwards.

## Corrections to the design spec

`docs/superpowers/specs/2026-08-11-mail-mcp-design.md` predates these
measurements and is wrong in three places. Fix the spec or trust this file.

1. **Section 3.4, cold start.** The spec says the ~6.8s first call follows Mail
   being *idle*. Evidence says it follows Mail's *process* being freshly
   launched: once Mail has serviced any Apple Event since its own process
   started, both repeat in-process calls and brand-new `osascript` processes are
   cheap. The 6.80s figure itself is `[unverified]` and was never reproduced,
   because Mail had been running for days and quitting the user's Mail was not
   permitted.
2. **Sections 3.2 and 11, scaling.** The spec extrapolates linearly to about 25s
   at 100k messages. Reality is worse than linear; see above.
3. **Gmail's virtual INBOX. UNRESOLVED, and it affects inbox resolution.** The
   spec claims, inheriting from upstream, that `All Mail` is nested inside a
   `[Gmail]` container and does not resolve by a flat lookup. On this machine
   **no account exposes an `All Mail` mailbox at all**, and the Gmail-style
   account's 27 mailboxes are all flat at depth 0. Settle this with a probe
   before implementing any Gmail-specific inbox handling. Do not implement the
   spec's version on faith.

## Open questions for the implementation

- All draft, reply and forward recipes are unverified. `reply ... without opening
  window` is required rather than optional: with a compose window, `set content`
  silently no-ops because the window is not ready, producing an empty body, and
  it reproduces specifically from background processes, which is how an MCP
  server always runs.
- The in-script deadline has no confirmed JXA equivalent of AppleScript's
  `with timeout of N seconds`. Only the outer process timeout is proven.
- Attachment enumeration should parse the MIME `source` rather than trust Mail's
  attachment objects, and `source` must not be fetched unless HTML or attachments
  are actually requested. Upstream returned the whole raw MIME blob mislabeled as
  the HTML body.
