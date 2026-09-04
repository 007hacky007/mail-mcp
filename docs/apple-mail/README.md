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
3. **Gmail's virtual INBOX. SETTLED by direct measurement, 2026-08-11.** The
   spec claims, inheriting from upstream, that a Gmail account's literal
   `INBOX` holds roughly nothing, real mail lives in `All Mail` / `Important`
   nested inside a `[Gmail]` container, and a flat mailbox lookup fails.
   `research/probes/08-gmail-inbox.js` (recorded in
   `research/results/08-gmail-inbox.json`) asked exactly that question,
   per account, of a confirmed Gmail-backed account (server name matched, not
   guessed from mailbox names). Every claim failed on this machine:

   - The Gmail account's literal `INBOX` resolves by flat `byName("INBOX")`
     and holds 52,147 messages, the largest INBOX on the machine.
   - `All Mail` exists nowhere: not by flat lookup, not anywhere in a full
     recursive walk of all 28 of the account's mailboxes.
   - `Important` exists nowhere either.
   - The only mailbox containing other mailboxes is an ordinary user folder;
     there is no `[Gmail]` (or any other) grouping container.

   The likely cause is Gmail's IMAP folder-subscription settings, which can
   hide `[Gmail]`-prefixed folders from IMAP clients entirely; this was not
   confirmed and does not need to be. **Design decision:** the server does no
   Gmail-specific inbox handling. The inbox is the account's `INBOX` mailbox,
   resolved flat and validated against the enumerated mailbox list like every
   other mailbox. A machine whose Gmail account does expose `[Gmail]`
   containers still works, because mailboxes are always enumerated and
   resolved by full path, never assumed; its `All Mail` would simply appear
   in the tree like any other mailbox.

## Draft recipes: verified 2026-08-11, with a new trap; corrected 2026-09-04

All three draft recipes were verified against real Mail (16.0, macOS 26.6.1)
while building the server's draft tools, and the verification found a trap
that upstream's issue #7 does not cover. One conclusion drawn on 2026-08-11
was wrong and is corrected below (the quoting bullet):

- **create-draft works as specified.** `Mail.OutgoingMessage({visible: false})`
  pushed onto `outgoingMessages`, recipients as child objects, attachments via
  `msg.attachments.push(Mail.Attachment({fileName: Path(p)}))` (the direct
  element worked; no content-element fallback needed), then `Mail.save(msg)`
  files it into Drafts. Subject, recipients, body and attachment all
  round-tripped.
- **`reply`/`forward ... without opening window` is necessary but NOT
  sufficient.** The new finding: **reading `content()` before setting it
  poisons the draft.** A fresh reply's `content()` reads back empty, and after
  that read, `out.content = body` silently no-ops - the draft saves as the
  bare quote skeleton without the body, with no error anywhere. Setting
  content immediately, without any prior read, works. Measured directly with
  three variants on the same seed message; only set-without-prior-read
  produced a saved draft containing the body.
- **CORRECTED 2026-09-04: setting `content` discards Mail's quote.** This
  file previously claimed Mail appends the quoted original below the set
  content at save time. That was inferred from the poisoned case above, where
  the quote skeleton survived without the body, and it does not hold for the
  working path. Measured against Mail 16.0 (3864.700.51.1.1) with the
  server's exact recipe (`reply` without window, set content immediately,
  save), then reading the saved draft back out of `Mail.draftsMailbox`: the
  draft holds the body and the signature, carries `In-Reply-To` and
  `References`, and has no quoted original at all. The control (same reply,
  content never set, save) does hold Mail's `On <date>, <sender> wrote:`
  block, so the quote exists only while content is untouched. `forward`
  behaves the same: with a note set, the `Begin forwarded message:` block and
  the message vanish; without one, Mail builds the forward correctly.
  Inserting instead of replacing was tried and fails: `make new paragraph` at
  `content.paragraphs.beginning` ("Invalid key form"), at `content.beginning`
  ("Can't convert types"), before `paragraphs[0]` ("Invalid index"); and
  `paragraphs.unshift` returns without error but no text lands and the quote
  is still dropped, both before a save and after a first save (post-save
  `content()` is empty and `paragraphs()` is 0). The dictionary exposes no
  per-message quoting control; `reply` takes only `opening window` and
  `reply to all`. Consequence: the server builds the quote itself in Node
  (`src/mail/quote.mjs`) from the original's `content`, `sender` and `date
  sent` (fetched through the get-message script) and passes body + quote as
  one string; forward-with-note reproduces the forwarded block the same way.
  Mail still appends the signature after the set content; how the server
  gets it above the quote anyway is the two-pass bullet below.
- **`html content` works, despite the dictionary. Measured 2026-09-04.** The
  outgoing message's `html content` property (code `htda`) is marked
  `hidden="yes"`, `access="w"`, and described as "Does nothing at all
  (deprecated)". On Mail 16.0 (3864.700.51.1.1) it inserts the given string
  as raw HTML into the compose document: `<blockquote type="cite">` arrived
  intact and nested, `&lt;` decoded to `<`, UTF-8 text (`čšž`) survived, and
  the saved draft's text/html part contains the markup verbatim inside Mail's
  URL-share wrapper (`Apple-Mail-URLShareWrapperClass`, a borderless outer
  blockquote). After the set, `content()` reads back the plain-text rendering
  of that HTML (so the empty-body guard still works), `content.paragraphs()`
  counts its lines, and reading them does not disturb the subsequent save.
  Setting `content` with markup in it, by contrast, escapes everything
  (`&lt;b&gt;` in the saved HTML). The same property works on a `forward`
  outgoing message. This is what lets the server's quote render with Mail's
  own vertical quote bar instead of literal `>` characters: the respond-draft
  script applies the Node-built HTML via `html content`. Being hidden and
  nominally deprecated, it may vanish in a future Mail; the script reads
  `content()` back and refuses to save when it comes back empty, so that
  regression would be loud.
- **Signature placement: the two-pass harvest. Measured 2026-09-04.** After
  any content set, Mail appends the account signature at the very end, below
  the quote; re-assigning `message signature` afterwards changes nothing.
  `message signature` set to missing value suppresses it entirely. The
  bridge exposes a signature's `content` only as plain text (its attribute
  runs throw), the `.mailsignature` files under `~/Library/Mail` are
  TCC-protected ("Operation not permitted" without Full Disk Access), and
  `html content` replaces the document even after a prior `content()` read or
  a prior save, so Mail's own template can never be kept alongside a body.
  What works: save once with Mail's signature appended, locate that draft in
  `Mail.draftsMailbox` (exact subject plus an HTML comment marker in the
  decoded text/html part; found in 90-170 ms on this machine), cut the
  balanced `<div id="AppleMailSignature">` block out of its source, set
  `message signature` to missing value, set `html content` to body +
  signature + quote, save again. The second save replaces the draft (one
  entry in Drafts, a new per-mailbox message id) rather than adding one. Two
  traps: Mail deletes every element whose id is `AppleMailSignature` when the
  signature is missing value, and a real signature nests several such
  elements, so all of those ids must be stripped from the re-embedded block
  (stripping only the outermost kept just the trailing fragment). HTML
  comments and empty `<div id=...>` elements both survive Mail's
  serialization, which is what makes the marker reliable. A signature
  referencing `cid:` inline images cannot be moved this way (the image parts
  belong to the first-pass draft) and is left where Mail put it.
- **Post-save reads through the outgoing message object are unreliable**:
  `content()` reads back empty after `save` even when the saved draft is
  fine. Read every field back after the set but BEFORE save; only `id` is
  read after.
- **Read-back length is body length plus a trailing newline** Mail appends.
- **Where drafts land:** reply/forward drafts of a message appear in that
  account's `Drafts` mailbox. A create-draft under the default account (the
  Gmail-backed one here) was NOT visible under any of that account's mailbox
  paths - the account exposes no Drafts mailbox at all - but exists in the
  application-level `Mail.draftsMailbox` ("All Drafts", a property, not an
  account mailbox). A tool that cannot find a just-created draft by path
  should not conclude it was not created.

The server's reply/forward tools also read the content back after setting it
and refuse to report success when it is empty, so if a future Mail version
regresses this recipe, the failure is loud instead of a silently empty draft.

## Open questions for the implementation
- The in-script deadline has no confirmed JXA equivalent of AppleScript's
  `with timeout of N seconds`. Only the outer process timeout is proven.
- Attachment enumeration should parse the MIME `source` rather than trust Mail's
  attachment objects, and `source` must not be fetched unless HTML or attachments
  are actually requested. Upstream returned the whole raw MIME blob mislabeled as
  the HTML body.
