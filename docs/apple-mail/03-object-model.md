# 03. Object Model

The foundational reference. Every later document in this archive cites this
one for property names, types, and costs rather than re-measuring them:
what Mail.app exposes to AppleScript/JXA, what each property actually
returns and costs, and - the section that matters most - how message
identity really works and why getting it wrong produces intermittent,
hard-to-reproduce "message not found" failures.

## How to read this document

Same convention as `01-execution-model.md`: a plain statement backed by a
quoted command/recording is **verified**; a statement prefixed
`[unverified]` was mined from upstream's source or comments but not
executed here. See that document's "How to read this document" section for
the full definition; it is not repeated here.

One addition specific to this document: several claims below are verified
against Apple's own scripting dictionary (`sdef`), not just against probe
output. `sdef` reads the dictionary resource baked into the app bundle - it
touches no Mail.app state, opens no connection, and does not require Mail
to be running. Reproduce it yourself:

```bash
sdef /System/Applications/Mail.app | grep '<class name'
```

(`/Applications/Mail.app` returns `sdef: couldn't get sdef ... (error -43)`
on this machine - Mail.app on current macOS lives under
`/System/Applications/`. If your `sdef` output differs from what is quoted
below, that is itself worth recording: this document was generated against
macOS 26.6.1 (build 25G76), Mail.app version 16.0.)

## 1. The object graph

**Verified**, via the command above. Mail's scripting dictionary defines
these classes (irrelevant text/rich-text plumbing classes - `word`,
`character`, `attribute run`, `paragraph` - omitted):

```
application
  accounts (element)                    -- account, or a subclass of it
    mailboxes (element, nested)          -- mailbox / container
      mailboxes (element, nested again)
      messages (element)                 -- message
        headers (element)                -- header
        mail attachments (element)       -- mail attachment
        to/cc/bcc recipients (element)   -- recipient subclasses
  message viewer                         -- window-management object, not probed
  signature                              -- email signatures, not probed
outgoing message                         -- top-level, NOT a subclass of message
  to/cc/bcc recipients (element)
rule
  rule conditions (element)              -- rule condition
smtp server                              -- separate from account; account.deliveryAccount points to one
```

Account subclasses: `account` (base), `imap account`, `iCloud account`
(inherits `imap account`), `pop account`. `mailbox` has a subclass,
`container`, described as "a mailbox that contains other mailboxes" - but a
`container` is-a `mailbox` with the exact same properties (see section 3);
it is not a separate thing to special-case, and nothing in the dictionary
marks a specific mailbox as a `container` versus a plain `mailbox with
children` at the scripting level. `research/probes/03-mailboxes.js`
recurses into `mailboxes()` on every mailbox uniformly for this reason - it
never needs to check which subclass it got.

**`outgoing message` is not a subclass of `message`.** It is a wholly
separate class (`code="bcke"`, versus `message`'s `code="mssg"`), and its
property list is short: `sender`, `subject`, `content`, `visible`,
`message signature`, `id`. Verified from the dictionary: `outgoing message`
declares no `<element type="header">` at all (`message` does), which is the
dictionary-level reason behind the known-issues entry in this project's own
`CLAUDE.md` ("Manual headers on `outgoing message`... Mail.app's
`outgoing message` class doesn't expose a `headers` property") - it isn't
an oversight in upstream's code, there is genuinely no such element to read
or write on this class. `outgoing message.id` exists but is a different
Cocoa key (`uniqueID`) from `message.id` (`libraryID`) - nothing here
implies the two id spaces relate to each other, and this document does not
assume they do.

**What has no scripting representation at all: smart mailboxes.** The
entire `sdef` output (961 lines) contains zero occurrences of "smart" in
any class, property, or enumeration name - **verified** directly (`sdef
/System/Applications/Mail.app | grep -i smart` returns nothing). This
corroborates, independently, what this project's own `CLAUDE.md` already
states from experience: smart mailboxes are edited by writing
`SyncedSmartMailboxes.plist` directly, "because they edit
`SyncedSmartMailboxes.plist` directly... on localized macOS (e.g. German),
where AppleScript's smart-mailbox terms fail." The dictionary evidence goes
one step further than "the terms fail on localized systems" - there is no
term to fail on in the first place; a smart mailbox is a preference-file
construct the Mail.app UI renders, not an object the scripting bridge was
ever given a name for.

**`rule` is a real scriptable class** (properties: `name`, `enabled`, and
one property per rule action - `mark flagged`, `move message`, `delete
message`, `forward message`, etc. - plus a `rule condition` sub-element for
its match criteria). Out of scope for this task's probes; noted here only
because it means `list-rules`/`enable-rule`/`disable-rule` (see the
project's `CLAUDE.md`) have a real, first-class object to work with, unlike
smart mailboxes.

**A message's `headers` element is real and independently useful.**
Verified with a one-off read (not one of this task's three recorded
probes, so it is not covered by `research/verify.mjs`; quoted here as a
directly-run command with output, same standard as the ad-hoc commands in
`01-execution-model.md`):

```
$ osascript -l JavaScript -e '
function run(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const [acc, mb] = args;
  const m = Application("Mail").accounts.byName(acc).mailboxes.byName(mb).messages[0];
  const hs = m.headers();
  return JSON.stringify({ headerCount: hs.length, nameType: typeof hs[0].name(), contentType: typeof hs[0].content() });
}
' -- "<enabled account>" INBOX
{"headerCount":15,"nameType":"string","contentType":"string"}
```

A message's raw headers (`To`, `Subject`, `Received`, etc.) can be read
individually, each a `{name, content}` string pair, without touching
`source` (the expensive property - see section 4). `[unverified]` how
completely this matches the raw MIME header block, or whether any header
is folded/renamed by Mail's parser - not explored beyond confirming the
element exists and returns strings; a future document (`04-reading-recipes.md`,
Task 7) is where that exploration belongs.

## 2. Account properties

**Verified** - `research/probes/02-accounts.js`, recorded as
`research/results/02-accounts.json` (`node research/record.mjs
02-accounts`, no arguments; the probe takes none). This machine has 5
accounts, 2 enabled and 3 disabled:

| Property (JXA call) | sdef property | Observed type | Notes |
|---|---|---|---|
| `name()` | `name` | string | account display name |
| `enabled()` | `enabled` | boolean | see disabled-account section below |
| `accountType()` | `account type` | string | `"imap"` on all 5 accounts here (coerced with `String()` in the probe since the raw value is an enum, not a plain string) |
| `emailAddresses()` | `email addresses` | array of strings | can hold more than one address (the 32-mailbox account here reports 3); a disabled account still reports its configured address(es) |
| `userName()` | `user name` | string | the login/username, not necessarily an email address |
| `serverName()` | `server name` | string | |
| `mailboxes().length` | (element count) | number | **0 for every disabled account on this machine** |

Whole-probe cost: **0.727s for all 7 properties across all 5 accounts**
(`research/results/02-accounts.json`, `seconds` field) - cheap enough that
there is no reason for a tool to special-case or cache this call.

Two more account-level facts, verified but **not** part of this task's
three recorded probes (so not covered by `research/verify.mjs`; quoted here
as directly-run commands, same standard as section 1's `headers` check):

- **`account.id()` exists and is a string**, read-only, present and
  readable on every account including disabled ones (`sdef`: `<property
  name="id" ... type="text" access="r" description="The unique identifier
  of the account">`; verified with a one-off read returning `"string"` for
  all 5 accounts, enabled and disabled alike). `[unverified]` whether this
  id is stable across a Mail.app restart or a re-added account - not
  tested, since testing that would require restarting Mail, which this
  task's constraints forbid.
- **`mailbox` has no `id` property at all.** See section 3 - this matters
  for the ambiguous-leaf-name problem.

### Disabled accounts: distinguish "switched off" from "unreadable"

This is the fact this section exists to nail down, because upstream shipped
a bug getting it wrong (see below).

**Every single property probed above - `name`, `enabled`, `accountType`,
`emailAddresses`, `userName`, `serverName`, and `mailboxes().length` -
returned `ok: true` on all three disabled accounts on this machine,
recorded verbatim in `research/results/02-accounts.json`.** No property
raised. This is worth stating plainly because the natural expectation (and
this task's own brief, written before the probe ran) was that reading
*some* property of a disabled account would raise a scripting error -
measurement does not support that. What actually distinguishes a disabled
account, on this machine, at this moment, is exactly two things: `enabled()`
returns `false`, and `mailboxes().length` is `0`. Nothing throws.

This is not in tension with upstream's real bug; it explains it. Upstream's
`CHANGELOG.md` (fixed under issue #143):

> "An account switched OFF in Mail.app is no longer counted as an
> unreadable one, which could make an unscoped `get-unread-count` /
> `get-mail-stats` report a spurious `partial`... `planCountSources`
> assigned every Mail.app account a source - its matching IMAP config, else
> AppleScript - without consulting the account's `enabled` flag. A disabled
> account has no live connection, so an AppleScript count against it can
> fail server-side (AppleEvent -10000)... For a deliberately-disabled
> account that is simply untrue - nothing is missing and the total is
> exact."

The failure upstream hit was never in reading the *account object's own
properties* (name, enabled, cached server/user/email metadata) - those are
local/cached and, per the measurement above, always succeed. The failure
was in a *downstream operation that needs a live server connection* -
counting messages in a mailbox of a disabled account - which fails with an
opaque AppleEvent error (`-10000`). Upstream's own fix
(`src/services/appleMailManager.ts`, `disabledAccountGuard` /
`isAccountEnabled`) checks the cheap, always-succeeding `enabled` property
*before* attempting any operation that would need the connection, rather
than attempting the operation and interpreting a caught failure as "this
account is unreadable":

```typescript
// disabledAccountGuard(): "When the target account is disabled in Mail,
// Mail holds no live server session for it, so the operation fails inside
// Mail with an opaque AppleEvent -10000... Detect the disabled account up
// front and refuse with an actionable message instead of attempting the
// doomed op."
private disabledAccountGuard(account: string): string | null {
  if (this.isAccountEnabled(account) === false) {
    return `Account "${account}" is disabled in Mail, so Mail has no live ` +
      `connection to it - this operation would fail server-side (AppleEvent ` +
      `-10000) ...`;
  }
  return null;
}
```

**The design rule this section exists to state:** a tool must decide "is
this account switched off" by reading `enabled` up front, never by
attempting some other operation and treating a caught exception as proof
the account is broken. Catching a failed downstream operation and
mislabeling it "account unreadable" is exactly the shape of bug #143 was.

One more nuance from upstream worth carrying forward rather than
re-deriving, since it bears directly on how much to trust a clean
measurement like the one above: upstream's own changelog entry for #143
states the *failure* this fix addresses is itself intermittent - "Mail only
errors on a disabled account in some states, so the same call can return a
clean count on one run and a spurious `partial` on the next." `[unverified]`
whether that intermittency would also show up in the plain property reads
this section measured (all `ok: true`, one run, one moment) - this document
reports what one clean run showed, not a guarantee that every property read
against every disabled account, at every point in Mail's connection
lifecycle, always succeeds. The design rule above does not depend on that
guarantee anyway: it says decide from `enabled`, not from whether some
unrelated operation happened to succeed just now.

## 3. Mailbox properties

**Verified** - `research/probes/03-mailboxes.js`, recorded as
`research/results/03-mailboxes.json` (`node research/record.mjs
03-mailboxes`, no arguments - the probe walks every account it can see).

| Property (JXA call) | sdef property | Observed type | Notes |
|---|---|---|---|
| `name()` | `name` | string | |
| (derived) `path` | - | string | built by this probe, not by Mail - see below |
| (derived) `depth` | - | number | 0 for a top-level mailbox of an account |
| `messages.length` | (element count) | number | `-1` sentinel on the probe's failure fallback, never observed as a real failure here |
| `unreadCount()` | `unread count` | number | |

Two more mailbox-class facts from the dictionary, not from this probe
directly:

- **`mailbox` declares `account` (read-only, back to the owning account)
  and `container` (read-only, the parent mailbox if nested, or a "missing
  value"/no-parent otherwise) - and nothing else.** In particular:
  **`mailbox` has no `id` property.** Verified two ways: the dictionary
  simply does not list one (contrast with `message`, which has an explicit
  `id` property - see section 4), and empirically -
  `mailbox.id()` raises `Error: Can't get object.` on every mailbox tried.
  Unlike a message, a mailbox has no numeric or string handle at all beyond
  its name and position in the tree. `[unverified]` beyond the dictionary
  and this one-off check whether `container` reliably resolves to `null` /
  "missing value" for a top-level mailbox versus a real object for a nested
  one in a way that is easy to test from JXA - a one-off attempt found
  `typeof container()` reporting `"function"` for both a top-level and a
  nested mailbox (JXA represents an object-typed property as a callable
  specifier proxy regardless of whether it is empty), so distinguishing
  "has no parent" from "has a parent" through `container` needs a further
  property read on it, not a `typeof` check - not pursued further here,
  since this task's probe (matching the brief) builds paths by walking
  top-down from each account instead of using this back-link at all.

### Nesting: measured, and it is not what "a `[Gmail]` container is common" predicts

**Verified.** Both enabled accounts show real nesting, but shallow (max
depth 1 on both), and **neither instance is a `[Gmail]`-style grouping
mailbox** - both are ordinary user subfolders:

| Account | Top-level mailboxes | Total walked entries (incl. nested) | Max depth | Nested entries |
|---|---|---|---|---|
| Account A (32 mailboxes per account probe) | 32 | 33 | 1 | 1 (a mailbox nested one level under another top-level mailbox) |
| Account B (27 mailboxes per account probe; Gmail-style) | 27 | 28 | 1 | 1 (a mailbox nested one level under a different top-level mailbox) |
| 3 disabled accounts | 0 | 0 | - | - |

The common expectation for a Gmail-backed account (Account B here) is a
`[Gmail]` container holding `All Mail`/`Important`/`Starred` as children.
**That did not happen on this machine.** All 27 of Account B's top-level
mailboxes, including its `INBOX` and `Spam`, sit at depth 0 with no
grouping container above them; the one nested mailbox found is an
ordinarily-named subfolder nested under an unrelated top-level folder, not
a Gmail construct.

### This directly contradicts this project's own design spec - flagged, not softened

`docs/superpowers/specs/2026-08-11-mail-mcp-design.md` (this project's
pre-archive design document, written from reading upstream, not from
independent measurement) states, in its table describing what
`08-quirks-and-traps.md` will cover:

> "Gmail's virtual INBOX (the literal `INBOX` holds roughly nothing; real
> mail lives in `All Mail` and `Important`, nested inside a `[Gmail]`
> container so a flat mailbox lookup does not find them)."

Three separate, checkable claims are packed into that one sentence, and
this task's measurements bear on all three - **verified, on this specific
Gmail-style account, on this machine, right now:**

1. **"The literal `INBOX` holds roughly nothing."** Measured directly
   (`research/results/03-mailboxes.json`, and confirmed again in this fix
   round via the `largest-enabled` selector - see below): this account's
   `INBOX` holds **52,143 messages** - not only "not roughly nothing," it
   is the single largest INBOX of any account on this machine, larger than
   the other enabled account's 17,487-message INBOX that this document's
   message-property measurements are based on.
2. **"Real mail lives in `All Mail`... nested inside a `[Gmail]`
   container."** Measured directly, twice: the full recursive mailbox walk
   (`research/probes/03-mailboxes.js`) never encountered a literal `[Gmail]`
   mailbox anywhere in this account's tree (a standard name, so it would
   have survived redaction and appeared verbatim in the recording if
   present - it did not); and, testing the specific claim more precisely in
   this fix round, `account.mailboxes.byName("All Mail")` **fails outright**
   on this account - `Error: Can't get object.` - not merely "not flat," but
   not found at all, at any depth, by that name.
3. **"So a flat mailbox lookup does not find them."** This framing implies
   a *nested* lookup would succeed where a flat one fails. That is not what
   was tested here, but it is hard to square with fact 2: there is no
   literal `[Gmail]` mailbox for a nested lookup to descend into in the
   first place on this account.

**This is a real, measured contradiction, not a probe artifact.** Both
enabled accounts were checked, not just the Gmail-style one - **verified**:

```
$ osascript -l JavaScript -e '
function run() {
  const Mail = Application("Mail");
  const out = [];
  for (const a of Mail.accounts()) {
    let enabled;
    try { enabled = a.enabled(); } catch (e) { enabled = null; }
    if (!enabled) continue;
    let allMailOk, allMailErr;
    try { a.mailboxes.byName("All Mail").name(); allMailOk = true; }
    catch (e) { allMailOk = false; allMailErr = String(e).slice(0,60); }
    out.push({ allMailOk, allMailErr });
  }
  return JSON.stringify(out);
}
'
[{"allMailOk":false,"allMailErr":"Error: Can't get object."},
 {"allMailOk":false,"allMailErr":"Error: Can't get object."}]
```

Neither of the two enabled accounts on this machine exposes a mailbox
literally named `All Mail`, reachable by that name, at all. Per this
task's coordinator's explicit instruction: **this measurement is kept as
measured, and the spec's claim is kept as written - both stay in the
archive, flagged as in direct conflict, rather than editing either to
agree with the other.** `[unverified]` why the discrepancy exists - whether
it is specific to this Gmail account's IMAP folder subscription settings
(Gmail lets a user hide folders like `[Gmail]/All Mail` from IMAP
entirely), specific to how this Mail.app version presents Gmail folders,
or something the design spec's own upstream source got wrong in the first
place - resolving this is explicitly `08-quirks-and-traps.md`'s job (a
later task, which already reserves probe fields for exactly this -
`isGmailStyle`, `literalInbox`, `allMail`, `containerNames`), not this
document's. The concrete, load-bearing fact for *this* document, unaffected
by which explanation turns out to be right: this probe's generic recursive
walk needs no Gmail-specific logic at all to enumerate every mailbox this
account actually has, and a document (or a `gmail-style` account selector -
see below) that assumed a `[Gmail]` container or an `All Mail` mailbox
would exist and coded around it would have coded around something that, on
this real account, is not there.

Whole-probe cost: **29.941s** to walk all 5 accounts (61 total mailbox
entries across the two enabled accounts; the three disabled accounts
contribute 0 each), recorded in `research/results/03-mailboxes.json`. A
second live run (via `node research/verify.mjs`, not written back to the
recording) measured 20.43s for the same walk. Roughly 0.3-0.5 seconds per
mailbox on average either way. This is a meaningfully different cost regime
from the bulk *message-property* fetch measured in section 4 and in
`research/results/12-message-sizes.json`: walking N *mailboxes* costs
roughly N times one mailbox's cost (each mailbox's `name`/`unreadCount`/
message-count read is its own Apple Event), where reading one *property*
for every message *inside* one mailbox is a single bulk fetch regardless of
message count. Enumerating many mailboxes and enumerating many messages in
one mailbox are not the same operation and do not share a cost model - a
future document should not assume the second finding (bulk fetch is cheap)
extends to the first (mailbox enumeration is still one Apple Event per
mailbox).

### Full-path construction, and why full paths are mandatory

`path` is built by this project's probe, not read from Mail: `path =
prefix ? prefix + "/" + name : name`, walked top-down from each account
(see `research/probes/03-mailboxes.js`, `walk()`). This is necessary
because - verified directly in this same recording - **leaf names collide,
both across accounts and within a single account:**

```bash
node -e '
const fs = require("fs");
const j = JSON.parse(fs.readFileSync("research/results/03-mailboxes.json", "utf8"));
const seen = new Map();
for (const acct of j.data.accounts) {
  for (const box of acct.mailboxes) {
    if (!seen.has(box.name)) seen.set(box.name, []);
    seen.get(box.name).push({ account: acct.name, path: box.path });
  }
}
for (const [name, occurrences] of seen) {
  if (occurrences.length > 1) console.log(JSON.stringify({ name, occurrences }));
}
'
```

Run against the committed recording, this prints exactly the rows in the
table below - one line per name that occurs more than once anywhere in the
walk (the redactor's per-run pseudonym map guarantees two different real
names never collapse onto the same output name, so a repeated name in this
output is a genuine repeated real name, not a redaction artifact):

| Name (redacted pseudonym or standard mailbox) | Where it occurs |
|---|---|
| `INBOX` | Account A (top level) and Account B (top level) - expected, a standard name |
| `Spam` | Account A (top level) and Account B (top level) - expected, a standard name |
| `Folder 5` (a real, non-standard folder name) | Account A (top level) **and** Account B (top level) - the *same* real folder name exists as a top-level mailbox in two different accounts |
| `Folder 23` (a real, non-standard folder name) | Account A (top level) **and** Account B (top level) - same situation, a second real name duplicated across accounts |
| `Folder 35` (a real, non-standard folder name) | Account B, **twice**: once as a top-level mailbox (path `Folder 35`), once nested one level under a *different* top-level mailbox (path `.../Folder 35`) - same account, same name, two different mailboxes, and a full path correctly tells them apart |
| `Junk` | Account A, **three separate mailbox objects**: two both at the *top level* (identical name, identical resulting path `Junk`, but different message/unread counts - one holds real mail, the other is empty) plus one nested one level under an unrelated top-level folder |

The `Junk` case is the sharper warning: **two distinct top-level mailbox
objects in the same account report the identical name, at the identical
depth, which produces the identical constructed path** (`Junk` and `Junk`
are the same string). A full path built purely by name concatenation
disambiguates a name that recurs *at different depths* (the `Folder 35`
case) but cannot disambiguate two *true siblings* that happen to share a
name - and, per this section's own finding above, `mailbox` has no `id`
property to fall back on when that happens. `[unverified]` what causes two
same-named top-level mailboxes to coexist in one account in practice (a
server-side folder literally named "Junk" alongside Mail.app's own special
Junk mailbox is one plausible explanation, not confirmed here) - the
measured fact that stands regardless of cause is that it happens on this
real account, and that name-based full paths are necessary but not
provably sufficient.

**The consequence for tool design:** always resolve and report a mailbox by
its full path, never by a bare leaf name alone (a bare `"Junk"` is
ambiguous on this account in a way a caller cannot detect without querying
further); and treat "the path resolved to more than one mailbox" as a real,
reportable outcome rather than an impossible case, because it has now been
observed to happen. This is also, independently, the stated behavior this
project's own `CLAUDE.md` documents for `move-message`/`rename-mailbox`/
`delete-mailbox`: "A leaf name matching more than one mailbox... is
refused with an error naming every candidate."

## 4. Message properties

**Verified** - `research/probes/04-message-props.js`, recorded as
`research/results/04-message-props.json` (`node research/record.mjs
04-message-props 0 INBOX` - see "Probe arguments are selectors, never raw
names" below for what `0` means and why this changed from an earlier draft
of this document, which took a raw account name here). This probe reads
**one** message (`box.messages[0]`) and times each property individually,
deliberately not bulk-fetched - see the callout after the table for why
that choice changes the entire result.

| Property (JXA call) | sdef property | Observed type | Notes |
|---|---|---|---|
| `id()` | `id` | number (integer) | see section 5 - this is the whole point of this document |
| `messageId()` | `message id` | string | the RFC `Message-ID` header, without angle brackets |
| `subject()` | `subject` | string | |
| `sender()` | `sender` | string | `"Display Name" <address>` form |
| `dateReceived()` | `date received` | **Date** (a real JS `Date` object; this probe's own code wraps it in `String()` before recording, so the *recorded* `type` field reads `"string"` - the native call returns an object satisfying `instanceof Date`, verified with a one-off read) | |
| `dateSent()` | `date sent` | Date, same caveat as above | |
| `readStatus()` | `read status` | boolean | |
| `flaggedStatus()` | `flagged status` | boolean | |
| `flagIndex()` | `flag index` | number | per the dictionary: "-1 if the message is not flagged" |
| `messageSize()` | `message size` | number (bytes) | bulk-fetchable and cheap in bulk - see `research/results/12-message-sizes.json`, cited below |
| `mailbox.name()` | (traversal, not a message property) | string | the containing mailbox's *name only* - not a full path; see section 5 |
| `replyTo()` | `reply to` | string | **singular** despite RFC 5322 allowing multiple `Reply-To` addresses - the dictionary exposes exactly one string, not a list; `[unverified]` what happens with a message carrying more than one |
| `toRecipients().length` | (element count) | number | |
| `ccRecipients().length` | (element count) | number | |
| `content().length` (via `String()`) | `content` | number (this probe measures string length, not the content itself) | |
| `source().length` (via `String()`) | `source` | number | see the warning below |
| `mailAttachments().length` | (element count) | number | MIME-embedded attachments are invisible here - see the forward pointer to `07-attachments.md` in a later task |

### The uniform-cost finding: `source` is not "the expensive one" here, and this refutes the natural expectation

The natural expectation - stated in this task's own brief before the probe
ran - was "most properties are milliseconds; `source` is the expensive
one." **Measurement, repeated four times against the same account's
17,486-to-17,487-message INBOX (the small count drift between runs is real
mail arriving on a live mailbox between measurements taken hours apart, not
noise in the method), refutes this cleanly:**

| Run | Range across all 17 properties | `id` | `source` (via `sourceLength`) |
|---|---|---|---|
| Committed recording (`research/results/04-message-props.json`, selector `0`, fix round 1) | 0.742s - 1.451s | 0.959s | 1.052s |
| Ad-hoc run, before the selector fix (same account, raw name) | 0.480s - 2.366s | 1.697s | 0.735s |
| Ad-hoc run, before the selector fix | 1.489s - 3.217s | 1.789s | 1.712s |
| Ad-hoc run, before the selector fix | 1.383s - 1.987s | 1.458s | 1.692s |

All four runs measure the exact same real account and mailbox (this
document's "Account A" throughout) - only the calling convention changed
between the first row and the other three (see "Probe arguments are
selectors, never raw names" below), not the target. In every run, `source`
sits comfortably inside the same range as trivial, tiny properties like
`id`, `flagIndex`, and `attachmentCount` - it is never the outlier, and the
four runs' ranges overlap heavily rather than clustering around
dramatically different values. The dominant cost is not the property being
read; it is resolving `box.messages[0]` - an *index specifier* - against a
mailbox with roughly 17,500 messages, paid again on every single top-level
property call inside this probe's `run()`, because JXA does not cache that
resolution between separate synchronous calls in the same script.

**Confirmed directly** by running the identical probe against a 3-message
mailbox (`Drafts`) in the same account instead of the 17,486-message
`INBOX`:

```
[["id","0.065",true],["messageId","0.008",true],["subject","0.012",true],
 ["sender","0.020",true],["dateReceived","0.017",true],["dateSent","0.019",true],
 ["readStatus","0.012",true],["flaggedStatus","0.021",true],["flagIndex","0.013",true],
 ["messageSize","0.016",true],["mailboxName","0.019",true],["replyTo","0.021",true],
 ["toRecipients","0.012",true],["ccRecipients","0.021",true],["contentLength","0.068",true],
 ["sourceLength","0.010",true],["attachmentCount","0.020",true]]
```

Every one of the same 17 properties drops to single-digit-to-tens of
milliseconds. **"Cost class" is not an intrinsic attribute of a property in
this object model - it is a function of how the message is reached:**

| Reach pattern | Cost (this machine) | Source |
|---|---|---|
| Single-index specifier (`messages[0]`), small mailbox (3 messages) | 8-68 ms per property | ad-hoc run above |
| Single-index specifier (`messages[0]`), medium mailbox (~17,500 messages) | 0.48-3.2s per property, uniformly - no property is a clear outlier | this section's four runs |
| Single-index specifier (`messages[0]`), larger mailbox (52,143 messages, the `largest-enabled` account - see below) | **did not complete inside a 240-second timeout, for all 17 properties combined** | ad-hoc run, this fix round (`spawnSync osascript ETIMEDOUT` after 240.0s) - see the exact command, output, and why 240s specifically, immediately below the table |
| Bulk array fetch (`mailbox.messages.messageSize()`), the ~17,500-message mailbox, all messages at once | 1.211s-2.064s **total** across two separate measurements, for **all ~17,500** values - about 0.07-0.12ms per message | `research/results/12-message-sizes.json` (this fix round, selector `0`) and Task 4's original recording of the same account, cited for comparison |
| Bulk array fetch, the 52,143-message mailbox, all messages at once | **40.4s-53.0s total** across two separate measurements, for all 52,143 values - about 0.77-1.02ms per message | two ad-hoc runs, this fix round (same `runProbe` call as the `largest-enabled` demonstration below, run twice) |

**Correcting a mistake made and caught while writing this very section:** an
earlier draft of this table stated the 52,143-message bulk fetch at
"1.211s total" - that number is real, but it is Task 4's *other* account
(~17,500 messages), copied into the wrong row while writing this update.
The actual 52,143-message bulk-fetch timing, re-measured directly rather
than trusted from memory, was 40.398s on a first run - given, at that
point, as a single number. Re-running the identical command a second time
while preparing the selector demonstration below returned 53.011s instead,
a genuine ~30% difference for the identical operation on the identical
mailbox minutes apart - so the range above (40.4s-53.0s), not a single
point value, is what this document actually reports, once both numbers
were in hand rather than trusting the first one as representative. Left in
as a visible, narrated correction rather than silently fixed twice over,
because "an inherited, half-remembered, or under-sampled number stated as
measured fact" is the exact failure category this whole archive exists to
catch, and this document is not exempt from making that mistake itself -
twice, in the same paragraph, while writing about exactly this problem.

**The 240-second-timeout figure, in full, since it is the single most
dramatic number in this document and this task's coordinator correctly
flagged it as needing exact provenance rather than a bare claim.** This is
an ad-hoc, single-run observation - not a committed recording, which is
also what the table's "Source" column has said throughout - reproduced here
as the exact command and its exact output, per this archive's own
verified/`[unverified]` standard:

```
$ node -e '
import("./research/harness.mjs").then(async ({ runProbe }) => {
  const r = runProbe("04-message-props", ["largest-enabled", "INBOX"], 240000);
  if (!r.ok) { console.log("FAILED after", r.seconds.toFixed(1), "s:", r.error); return; }
  console.log("ok");
});
'
FAILED after 240.0 s: spawn failed: spawnSync osascript ETIMEDOUT
```

**Why 240000 (240s) and not `research/harness.mjs`'s documented
`DEFAULT_TIMEOUT_MS` of 120000 (120s):** the first attempt at this exact
measurement used the default (calling `runProbe` with only two arguments,
no explicit timeout), and it also failed to complete - the command ran
long enough that this session's own shell tooling moved it to a background
task rather than returning a normal result, consistent with hitting the
120-second internal timeout at roughly the same time. Rather than report
an ambiguous "didn't finish, exact cause unclear," the timeout was
deliberately doubled to 240000ms and the command re-run, to distinguish
two different possibilities: "merely slow, and would finish given
noticeably more time" versus "not converging in any short multiple of the
default." **It did not complete at 240s either** - the result quoted above.
This is the whole of the evidence: two runs, one at 120s (inconclusive -
background-tooling artifact, not a clean `ETIMEDOUT` transcript) and one at
240s (`ETIMEDOUT`, quoted in full above). `[unverified]` whether the
operation would complete at some longer timeout, and if so how long that
would take, and whether the underlying cost grows linearly, polynomially,
or some other way past this point - no third, longer run was attempted,
both because the qualitative conclusion below does not depend on the exact
number and because that would mean tying up the user's live Mail.app for
several more minutes for a single data point. What **is** verified,
plainly, without hedging: this exact operation, which completes in
seconds on the ~17,500-message mailbox, did not complete within 240
seconds - four times the harness's own default timeout - on the
52,143-message mailbox.

**With the correct numbers, the bulk-fetch row tells its own, smaller
version of the same story as the single-index rows.** ~17,500 to 52,143
messages is roughly a 3x increase in mailbox size; 1.2-2.1s to 40.4-53.0s is
roughly a 19x-44x increase in bulk-fetch time - worse than linear, though
nowhere near as catastrophic as the single-index case's jump from
"seconds" to "did not finish in 240 seconds" for the same 3x size increase.
Both directions degrade worse than proportionally as the mailbox grows;
they simply start from very different baselines. Bulk fetch is not immune
to mailbox size, it is just far more resilient to it. `[unverified]` the
exact scaling curve for either pattern - two or three data points each is
not enough to fit a curve, only enough to reject "constant" and "linear"
as descriptions and confirm "worse than linear" qualitatively for both.

**The comparison that matters most for tool design:** reading one property
for one message via an index specifier on the ~17,500-message mailbox
costs roughly **13,000 to 19,000 times more per message** than reading the
same property for every message via a bulk array fetch on that same
mailbox (about 1.5-2.4 seconds for 1 message versus about 0.0001 seconds
per message in bulk) - and per the rows above, that gap does not merely
persist but *widens* on the larger mailbox: the single-index side goes
from "seconds" to "does not finish," while the bulk side goes from
fractions of a second to tens of seconds, still trivially usable. **A
design relying on single-index message access must never assume its cost
is bounded by a constant, or even by anything better than "eventually
prohibitive," as a mailbox grows** - see `05-search.md` for how this
project's tools avoid this shape of access entirely, and see "Probe
arguments are selectors, never raw names" below for the exact `largest-enabled`
measurement these numbers come from.

### The two selector keywords, demonstrated directly

The numbers above for the 52,143-message mailbox come from the
`largest-enabled` selector, run twice through `research/harness.mjs`
directly (not through `record.mjs`, so nothing overwrote the committed
`index 0` recordings) and manually redacted before printing, the same
standard this document uses for every other ad-hoc command. **Verified:**

```
$ node -e '
import("./research/harness.mjs").then(async ({ runProbe }) => {
  const { redact } = await import("./research/redact.mjs");
  const r = runProbe("12-message-sizes", ["largest-enabled", "INBOX"]);
  console.log(JSON.stringify(redact(r.data)), "seconds:", r.seconds);
});
'
{"fetchOk":true,"fetchError":"<str len=0 chars=ascii>","accountName":"Account A",
 "messageCount":52143,"maxSizeBytes":34284502,"medianSizeBytes":14941,
 "over1MB":912,"over4MB":282,"over16MB":39,"over64MB":0} seconds: 40.398181833
```

(run a second time, minutes later, to get the range quoted above: identical
`accountName`, `messageCount`, and every size statistic; `seconds:
53.010752041` instead of `40.398181833` - the only thing that changed.
**The `"Account A"` pseudonym shown here is a labeling trap, called out
explicitly rather than silently corrected:** `redact()` assigns pseudonyms
in first-seen order *within one call*, not globally and not by which real
account it is - this isolated command's `redact()` call sees exactly one
account name, so it always lands in the first slot, "Account A," regardless
of which real account that name belongs to. It does **not** correspond to
this document's own "Account A" (the 32-mailbox, ~17,500-message account)
used everywhere else in this document. The account measured here is
genuinely the one this document elsewhere calls **Account B** - confirmed
by the message count alone: 52,143 matches Account B's `INBOX`, not
Account A's ~17,500.)

`largest-enabled` correctly resolved to the account with 52,143 `INBOX`
messages - the account this document calls **Account B** (the Gmail-style
account with 27 mailboxes, per section 3) - **not** the account this
document calls Account A (32 mailboxes, ~17,500 `INBOX` messages), which
an earlier, informal description in this document's own history called
"the largest enabled account" by mailbox *count*. That earlier phrase was
imprecise in a way that mattered once a selector had to encode it exactly:
by mailbox count, Account A is larger (32 vs. 27); by `INBOX` message
count - the definition this fix round's selector actually implements -
Account B is larger, by a wide margin (52,143 vs. ~17,500). Both facts are
true; they are just about different measures of "largest," and this
document now says which one `largest-enabled` means rather than leaving it
ambiguous.

`gmail-style`, tested the same way, throws on this machine - **verified**,
and consistent with the section 3 contradiction above:

```
$ node -e '
import("./research/harness.mjs").then(({ runProbe }) => {
  const r = runProbe("04-message-props", ["gmail-style", "INBOX"]);
  console.log("ok:", r.ok, "| error (script path prefix stripped):",
    r.error.replace(/^.*04-message-props\.js:\s*/, ""));
});
'
ok: false | error (script path prefix stripped): execution error: Error:
Error: selector "gmail-style": no enabled account exposing an "All Mail"
mailbox was found (-2700)
```

(`r.error`'s real, unedited text is prefixed with this script's own
absolute filesystem path, which - unlike everything else quoted in this
archive - is stripped here rather than shown verbatim, since it necessarily
contains this machine's local username as a path segment; every other
detail of the message, including the exact error text and the `(-2700)`
AppleEvent code, is otherwise unedited.)

This is the resolver working exactly as designed, not a bug in it: neither
enabled account exposes a mailbox literally named `All Mail` (section 3),
so `gmail-style` correctly has nothing to resolve to, and fails loudly
(a whole-probe failure, visible to `research/verify.mjs` as "probe did not
run") rather than silently returning a plausible-looking wrong answer.
`12-message-sizes.js` wraps its own `resolveAccount` call in the existing
try/catch instead, so the *same* failure there produces the graceful
`fetchOk: false` result its design has always used for a bad account or
mailbox name - demonstrated directly, and safely (no personal data - the
`accountName` field is a redacted pseudonym of the empty string this
probe's own default value produces when resolution fails before an account
was ever found, not a real name):

```
$ node -e '
import("./research/harness.mjs").then(async ({ runProbe }) => {
  const { redact } = await import("./research/redact.mjs");
  const r = runProbe("12-message-sizes", ["gmail-style", "INBOX"]);
  console.log(JSON.stringify(redact(r.data)));
});
'
{"fetchOk":false,"fetchError":"<str len=90 chars=ascii>","accountName":"Account A",
 "messageCount":0,"maxSizeBytes":-1,"medianSizeBytes":-1,"over1MB":-1,
 "over4MB":-1,"over16MB":-1,"over64MB":-1}
```

(The `"Account A"` pseudonym shown here is an artifact of this one-off
command's own, separate redaction pass being handed only the empty string
`accountName` defaults to before resolution ever succeeds - it does not
correspond to this document's "Account A" elsewhere; `pseudoAccount()`
assigns labels per `redact()` call, in first-seen order within that call,
not globally, so a lone or empty value being the first thing redacted in
an isolated command gets whatever label is first in sequence regardless of
which real account, if any, it came from.)

Neither ad-hoc command above touched the committed `research/results/`
recordings, which remain the `index 0` (Account A) measurements described
throughout this document.

### The `source`/`content` warning, restated correctly

`source` and `content` still deserve their own warning - just not the one
the raw per-call timing above shows. Their real cost is **size**, not
per-call latency: `01-execution-model.md` section 4 measured this
mailbox's `messageSize` distribution directly - median 8,077 bytes, maximum
26,711,953 bytes (about 25.5 MB), 138 messages over 1 MB. A `source` read
on the large end of that distribution returns tens of megabytes of text
through the same `osascript` child process whose `maxBuffer` that same
section explains is set to 64 MB for exactly this reason. The message this
task's probe happened to read was small (12,966-byte source, matching its
13,367-byte `messageSize`, redacted to a length-only descriptor in the
committed recording) - small enough that this run's timing shows no size
effect at all. Do not read the absence of a size effect in *this specific
sample* as evidence that `source` is cheap in general; it means only that
this one message was small. The buffer-limit reasoning in
`01-execution-model.md` section 4 - sized for the rare-but-real maximum,
not the common case - applies here without change.

### Probe arguments are selectors, never raw names - a false pass, found and fixed

An earlier draft of this document (and this probe) reported `verify.mjs`
at `7/7` after fixing a real but *smaller* problem: the `timed()` helper's
failure branch used to have a different key set from its success branch
(`{ok, seconds, error}` versus `{ok, seconds, type, sample}`), so a
property read that happened to fail reported a different shape than one
that succeeded. That fix (both branches now emit the identical five keys,
`sample` always coerced to a string) was real and is kept - but it treated
a **symptom** of a **much more serious defect**, which this section now
documents in full because catching it is the actual point of this fix
round.

**The defect: `research/verify.mjs` reported `7/7` while never once
touching real Mail data for this probe, or for `12-message-sizes.js`, on
any replay.** `record.mjs` redacts a probe's *output* (`data`) with
`redact()` - correct, `data` is never re-executed, only read. But the
original version of `record.mjs` redacted a probe's *arguments* (`args`)
the exact same way - and `research/verify.mjs` **replays a recorded probe
with its stored `args`, verbatim**, because reproducing the exact call is
the entire point of recording it. A raw account name is not a standard
mailbox name, so it does not survive `redact()`'s passthrough rules; it
became an opaque placeholder like `"<str len=5 chars=ascii>"` in the
committed recording. Every future `verify.mjs` run then called
`Mail.accounts.byName("<str len=5 chars=ascii>")` - a specifier that
resolves lazily and does not throw immediately, so the failure surfaced
one call later, inside `timed()`'s per-property try/catch, which (once the
shape-symmetry fix above was applied) reported a clean, shape-stable,
**completely fabricated** result: `ok: false` for every one of 17
properties, every single time, with total certainty, since
a placeholder resolves to nothing real on every machine, always. The
symmetric shape fix made this failure LOOK like a normal recorded shape
instead of a screaming inconsistency, which is precisely how it slipped
past a naive `7/7`.

**Reproduced directly, on this machine, using the actual committed files
from before this fix round** (the previous commit's probe and recording,
retrieved via `git show` into a scratch location, replayed with its own
stored placeholder args exactly as `verify.mjs` does):

```
total ok-flags found: 17
all false? true
```

All seventeen `ok` flags - one per property - were `false`. The shape
still matched, because the shape was never the thing that was wrong.
`research/verify.mjs` was, before this fix round, structurally incapable
of catching this: comparing `typeof true` to `typeof false` (both
`"boolean"`) can never reveal that one is a real success and the other is
a caught exception with no data behind it. **This is what "the archive's
trust contract" actually means in the worst case: a green checkmark that
verifies nothing, printed with total confidence, in this project's own
verification tooling - not just in a claim mined from upstream.**

**The fix has three parts, all now in place:**

1. **Probes take an account SELECTOR, never a raw account name.**
   `research/probes/04-message-props.js` and `research/probes/12-message-sizes.js`
   each define `resolveAccount(Mail, selector)`, supporting exactly three
   forms: a decimal string (a zero-based index into `Mail.accounts()`), the
   keyword `"largest-enabled"` (the enabled account with the most messages
   in its `INBOX`), and the keyword `"gmail-style"` (the enabled account
   exposing an `All Mail` mailbox - which, per this document's section 3,
   currently resolves to *no* account on this machine; `resolveAccount`
   throws in that case, which is the correct, loud behavior, not a bug in
   the resolver). The resolved account's real name is still reported in the
   output, as `accountName`, through the same `"accountname"` redaction
   rule this project already uses elsewhere - so a recording still
   documents which account was measured without the *argument* ever being
   personal.
2. **`record.mjs` now refuses to store an argument it cannot prove is
   non-personal, instead of redacting it.** A decimal integer, one of the
   two selector keywords above, or a name in `redact.mjs`'s own (now
   exported) `STANDARD_MAILBOXES` set is stored **verbatim**; anything else
   makes `record.mjs` exit with an error naming the argument's *position*
   (never its text, to avoid the refusal message itself becoming a leak)
   and telling the probe author to add a selector. Verified directly, this
   fix round: `node research/record.mjs 02-accounts "NotASelectorOrMailbox"`
   refuses and writes nothing (confirmed via a file checksum taken before
   and after - unchanged), while a real account/mailbox selector like `0
   INBOX` is stored and used exactly as given.
3. **`research/verify.mjs` itself now checks for this failure mode
   generically**, not just for these two probes. It scans a live replay's
   data for every boolean field whose key is exactly `"ok"` or ends in
   `"Ok"` (covers this project's two conventions, `{ok: ...}` and
   `{fetchOk: ...}`); if at least one such field exists anywhere and
   **every** one of them is `false`, it refuses to call that a match,
   regardless of what the shape comparison says. A probe with a genuine
   mix of successes and failures is not flagged - only a replay that
   touched real Mail data nowhere at all is. Re-running the exact
   reproduction above through this new check in the actual
   `research/verify.mjs` (not a reimplementation) confirms it fires with
   the intended message:

   ```
   FAIL 04-message-props: shape matches, but this replay reached only
   failure paths (every "*ok" flag in the live data is false) - this
   proves the recorded shape is stable, not that Mail's object model was
   actually exercised. Args used: ["<str len=5 chars=ascii>","<str len=5 chars=ascii>"]
   ```

**After all three parts of the fix, both probes were re-recorded with real
selectors** (`node research/record.mjs 04-message-props 0 INBOX` and
`node research/record.mjs 12-message-sizes 0 INBOX`) and `node
research/verify.mjs` now reports `7/7` **with every property in
`04-message-props` showing `ok: true` and real timings, and `12-message-sizes`
showing `fetchOk: true` with real distribution numbers** - not the
failure path. This is the difference between the two claims "verify.mjs
says 7/7" and "verify.mjs's 7/7 means something": only the second one is
now true, and it was not true before this fix round, in this project's own
tooling, for two of its seven probes.

The general lesson, for whoever writes the next probe or the next
verification layer in any project: **a value that must be replayed exactly
(an argument, a cache key, anything fed back into the system under test)
cannot go through the same lossy redaction as a value that will only ever
be read.** The two have different correctness requirements - a
descriptor is a fine stand-in for something read once and discarded, and a
liability for something that gets re-executed - and a redaction layer that
does not distinguish them will eventually produce exactly this failure
mode: a verification step that reports success because it stopped being
able to fail informatively, not because it stopped being able to fail.

### Fix round 2: a shape match still is not enough, and the fix was still position-blind

Fix round 1 above closed the total-failure false pass, but a follow-up
review (`task-5-rereview.md`) found the fix itself was narrower than
"generic" implied, in two independent ways - one a detection gap, one a
privacy gap. Both are fixed; both fixes ship with unit tests, not just a
hand-run transcript, because that is exactly what the review found
missing the first time.

**Gap 1 (High): a SINGLE property silently flipping is invisible to every
defense that existed after fix round 1.** `research/shape.mjs`'s
`diffShapes` compares only `typeof`, so `ok: true` and `ok: false` are both
`"boolean"` - structurally identical to it. Fix round 1's
`replayReachedOnlyFailurePaths` only fires when *every* flag is false. So:
if a future macOS/Mail.app update makes exactly one property permanently
unavailable - say `flagIndex` starts throwing while the other 16 properties
in `04-message-props` keep working - the probe still records `ok: false`
for that one property (its `timed()` wrapper is deliberately
shape-symmetric, per fix round 1), the fingerprint stays byte-identical
(shape doesn't encode which boolean, only that it's a boolean), and the
all-or-nothing check does not fire (16 of 17 flags are still true). `verify.mjs`
would report a clean match, forever, for exactly the kind of drift this
whole archive exists to catch - a real Mail.app version-to-version change,
one property at a time, not the whole object model vanishing at once.

**The fix: a SUCCESS PROFILE, recorded alongside the fingerprint, not
folded into it.** `research/successProfile.mjs` (new this fix round)
exports `collectSuccessProfile(data)`, which walks a probe's output and
returns a flat map of every `ok`-style boolean's exact location to its
value - `{"props.id.ok": true, "props.flagIndex.ok": true, ...}` - and
`diffSuccessProfile(recorded, live)`, which compares two such maps and
reports every path whose value differs, **in either direction**. A flag
going true-to-false is drift; false-to-true is reported too, since it
means the *original recording* captured a transient failure and should
itself be re-recorded - not merely that today's replay differs from
yesterday's. `research/record.mjs` now stores this profile as its own
top-level `successProfile` field, separate from `shape`; `research/verify.mjs`
diffs it separately from the shape comparison and from the fix-round-1
all-or-nothing check (kept as a backstop - see its own updated comment),
so the three signals - shape drift, per-property value drift, total
failure - stay individually readable in the output rather than merging
into one conflated FAIL.

**Proven to actually catch a single flag flip, not just asserted:**
the committed `research/results/04-message-props.json` was edited (a
scratch, throwaway edit, restored immediately after, verified identical to
the original via a full-file diff) to change one path's recorded value -
`props.flagIndex.ok` from `true` to `false` - simulating a *recording* that
had captured a broken state. Running the real, unmodified
`node research/verify.mjs` against that edited file:

```
FAIL 04-message-props: success-profile drift:
  props.flagIndex.ok: false -> true
```

Named exactly the one path that differed, in the exact `recorded -> live`
direction, while every other probe (including `04-message-props`'s own
shape comparison, which found nothing - both values are still `typeof
"boolean"`) reported clean. `7/7` dropped to `6/7` for exactly this one,
precise reason. The file was restored immediately afterward
(byte-identical, confirmed by `diff`), and `node research/verify.mjs`
returned to `7/7`.

**Gap 2 (privacy): the arg-storability check was position-blind, so a
personal, all-digit string could be stored verbatim.** Fix round 1's
`isStorableVerbatim` applied the identical test to every argument
position: "is this string a decimal integer, a known selector keyword, or
a standard mailbox name" - regardless of *where* it appeared. But this
project's own probes that take arguments use position 0 for an account
selector and position 1 for a mailbox name that is never meant to be read
as an index. A real, personal mailbox literally named `"12345"` (a
year-only archive folder is a plausible real example) or a phone number
passed as a probe's second argument would satisfy "is this string
all-digit" and be committed to the archive **verbatim** - the exact leak
this whole mechanism exists to prevent, just shifted from the account
position to the mailbox position.

**The fix: the rule is now POSITIONAL**, in `research/argStorability.mjs`
(new this fix round, extracted from `research/record.mjs` so it is
independently testable): position 0 accepts a decimal integer (an
account-list index) or a known selector keyword; every later position
accepts a standard mailbox name or a known selector keyword, but **never**
merely "made of digits" - an all-digit string is only ever safe as an
index, and an index is exclusively position 0's job. The refusal message
still names only the argument's position, never its text, unchanged from
fix round 1.

**Unit-tested, not just hand-verified this time.** Three new test files,
zero `osascript` calls (fixtures only, so they run inside `npm test`):
`research/test/argStorability.test.mjs` (15 tests - including the exact
FIX B hole, an all-digit string refused at position 1 but accepted at
position 0, plus the whitespace/casing/suffix exact-match variants the
re-review confirmed by hand), `research/test/successProfile.test.mjs` (12
tests - a flag flipping in both directions, a path appearing, a path
disappearing, multiple flips at once), and `research/test/failurePaths.test.mjs`
(9 tests - all-false, all-true, a documented-intentional mix, and the
exact "16 true / 1 false" scenario that motivated Fix A, asserted as
correctly *not* caught by this narrower check since that is now the
success profile's job). `npm test` reports 102 (66 before this fix round
plus these 36).

**Coverage gap, made explicit rather than assumed covered (the
convention this document now establishes for every future probe):**
this whole detection layer - both the fix-round-1 check and this fix
round's success profile - only ever protects a probe whose output
contains at least one `ok`-style boolean field. `research/probes/03-mailboxes.js`
and `07-coldstart.js` have none today (confirmed against their committed
recordings' `shape` strings) and get **no protection from either
mechanism**, relying solely on the plain shape/key-set comparison -
`research/probes/00-hello.js` and `01-argv-modes.js` don't touch Mail's
object model in a way this applies to at all (they test argv fidelity
itself with arbitrary punctuation, not an account/mailbox lookup). Neither
was re-recorded in this fix round, for a real, unresolved tension worth
stating rather than hiding: `requireStorableArgs`'s gate is not
probe-name-aware - it would refuse their own committed test arguments
(deliberately arbitrary strings like a quoted phrase or a backslash) just
as it would refuse a personal name, since neither is a decimal index, a
selector keyword, or a standard mailbox name. Re-recording either probe
today, with its existing test intent intact, would fail at the gate. This
is left as a known, out-of-scope gap for this fix round rather than
resolved (for example, by scoping the gate to only the probes that
actually take account/mailbox selectors) - both probes' *committed*
recordings predate the gate entirely and are unaffected by it unless and
until someone runs `record.mjs` against them again. **The requirement for
every future
probe in this archive (Tasks 6 through 13), stated plainly so it is a
requirement and not an accident:** every probe that touches Mail's object
model must include at least one `ok`-style boolean (a bare `ok`, or a
`*Ok`-suffixed name like `fetchOk`) reflecting whether its primary read
succeeded, specifically so this detection layer has something to protect
it with. A probe with no such field is invisible to both the all-or-nothing
check and the success-profile diff, and relies entirely on shape/key-set
drift being loud enough to notice on its own - which, per Gap 1 above, a
single silently-failing property is not.

### Fix round 3: the success profile's own array paths fabricated drift on ordinary list churn

A second review (`task-5-rereview-2.md`) confirmed fix round 2's five
items and found one new, High-severity defect in the fix itself: the
success profile's array paths were built from the raw array INDEX -
`accounts[2].mailboxCount.ok` - which the re-reviewer demonstrated
fabricates drift on completely ordinary changes, not just reordering.

**The defect, demonstrated two ways.** Inserting one mailbox in the middle
of a 5-item mixed true/false fixture shifted two later items' indices and
produced two diffs that read exactly like real regressions - a
`true -> false` and a `false -> true` line, textually indistinguishable
from a genuine per-property break. Separately, splicing one account out of
this project's own committed `research/results/02-accounts.json` produced
7 diffs, all attributed to whichever account the shift left sitting at the
removed account's old index - the wrong account - and only failed to
produce fabricated *flips* because every real flag in that file happens to
be `true` today. Appending at the tail stayed clean either way, confirming
the defect is specifically about insertion or removal at a non-terminal
position, not "any list change." **Why this matters as much as the
original defect:** accounts and mailboxes change constantly in ordinary
use - a folder gets added, an account gets disabled, a mailbox gets
renamed - and every one of those would have produced a wall of spurious
drift reports naming the wrong objects. A detector that cries wolf gets
ignored, and an ignored detector fails exactly as completely as one that
reports a false match.

**The fix: key array items by IDENTITY, not position.** `identitySegmentFor()`
in `research/successProfile.mjs` picks the first usable identity field from
an array item, in this order: `path`, then `name`, then `probe` - falling
back to the numeric index only when an item has none of the three as a
usable string. A worked example, before and after:

```
Before (position-keyed, fix round 2):
  accounts[2].mailboxCount.ok

After (identity-keyed, fix round 3):
  accounts[name=Account B].mailboxes[path=Folder 1/Sub].readOk
```

`path` is preferred over `name` deliberately, not arbitrarily: section 3 of
this very document already established that a bare mailbox name can
collide (two sibling mailboxes literally named `Junk` in the same
account), while a full path disambiguates it - the same reasoning applies
here. A subtlety specific to this project's actual data, found while
implementing this: `research/probes/02-accounts.js`'s account objects wrap
`name` in this project's own `attempt()` convention (`{ok, value}`, not a
bare string), so `identityValueOf()` unwraps that shape too, using the
wrapped `value` as the identity - without it, every account in this
project's own real recordings would still fall back to the index, and the
fix would not actually close the demonstrated bug for this project's own
data.

**Re-proven against the exact re-reviewer scenarios, not just asserted.**
The mid-list insertion fixture now reports exactly one diff - the genuinely
new item - and none of the fabricated flips. The `02-accounts.json`
deletion scenario, re-run with a fresh identity-keyed profile on both
sides (this project's real, redacted account data - the removed account's
own redacted name descriptor is `<str len=7 chars=ascii>`, one of the
generic descriptors discussed below, not a proper pseudonym, because this
particular account's real name is not email-shaped), now produces exactly
7 diffs, every one correctly naming the *removed* account's own identity,
none naming its former neighbor:

```
accounts[name=<str len=7 chars=ascii>].name.ok: recorded as true, missing from this replay
accounts[name=<str len=7 chars=ascii>].enabled.ok: recorded as true, missing from this replay
accounts[name=<str len=7 chars=ascii>].accountType.ok: recorded as true, missing from this replay
accounts[name=<str len=7 chars=ascii>].emailAddresses.ok: recorded as true, missing from this replay
accounts[name=<str len=7 chars=ascii>].userName.ok: recorded as true, missing from this replay
accounts[name=<str len=7 chars=ascii>].serverName.ok: recorded as true, missing from this replay
accounts[name=<str len=7 chars=ascii>].mailboxCount.ok: recorded as true, missing from this replay
```

**Identity values are redacted, and pseudonyms are stable - confirmed, not
assumed.** Both `research/record.mjs` and `research/verify.mjs` compute
this profile from already-redacted data (this fix round also corrected
`verify.mjs`, which previously computed the live profile from *raw* data -
harmless when only booleans were compared, but wrong the moment a real
string identity value is part of the path; fixed by redacting once and
reusing that copy for both the shape diff and the profile diff). Verified
directly: feeding `collectSuccessProfile` a fictional real-looking name
after running it through `redact()` first produces a path containing the
pseudonym, never the original string. Pseudonym stability was verified the
same way: calling `redact()` twice on the identical input produces the
identical pseudonym both times - `redact.mjs`'s pseudonym assignment is a
deterministic function of first-seen order within one call, never random
or process-state-dependent, so "the same input" genuinely produces "the
same identity" every time.

**One accepted, documented residual limitation, found while verifying the
above:** `research/probes/02-accounts.js`'s account names, once redacted,
are sometimes a proper pseudonym (`user4@example.com`, when the real name
happens to be email-shaped) and sometimes a generic length/character-class
descriptor (`<str len=5 chars=ascii>`, `research/redact.mjs`'s fallback for
a string it does not otherwise recognize) - and a descriptor is **not**
guaranteed unique: two different real accounts whose names happen to share
a length and character class would collide onto the identical
identity-keyed path. Verified this does not currently happen (this
machine's 5 accounts' descriptors are 3 unique pseudonyms and 2
different-length descriptors - no collision), and accepted rather than
worked around further, because rejecting a generic descriptor as "not a
real identity" would fall all the way back to the index for exactly the
non-email-shaped account names this fix exists to protect, silently
reintroducing the bug this whole round closes. Narrower than the
bug it replaces: a descriptor collision requires a coincidence (two
accounts of the same redacted name length and character class); the
index-based bug fired on every ordinary list edit, unconditionally.

**Renaming an item is a real, honest change worth reporting - made
readable rather than alarming.** An identity-keyed path changing when its
underlying item is renamed is correct behavior, not a defect: the flags
genuinely moved to a new location. Reporting it as two disconnected
`missing`/`new` lines would read exactly like data loss, though, so
`diffSuccessProfile` now recognizes the pattern - a path disappearing and a
structurally-identical path (same field name used for identity, same
surrounding structure) appearing elsewhere, carrying the identical recorded
value - and reports it as one line: `<old path> -> <new path>: renamed
(value unchanged: <value>)`. If the value also changed, the pair is
deliberately **not** merged - reporting a plain missing line and a plain
new line separately, since guessing "renamed and regressed" in one line
would be less honest than stating both facts plainly.

**Tightened, as a smaller second fix: the flag matcher itself.** The
original `/ok$/i` suffix test is case-insensitive, so it cannot tell
"fetchOk" (a real camelCase boundary) from "outlook" (a lowercase word that
merely happens to end in the letters o-then-k) - both read as "ends in ok,
ignoring case" to it. `isOkStyleKey` (exported from
`research/failurePaths.mjs`, imported by `research/successProfile.mjs` so
both modules share one definition rather than two copies that could drift
apart) now requires either an exact `ok` key (any case) or a suffix match
where the character immediately before `Ok`/`OK` is a lowercase letter or
digit - a genuine case transition. `fetchOk` and `readOk` match; `outlook`
and an all-caps word that coincidentally ends in `OK` (e.g. `BOOK`) do not,
since neither has that transition.

**Unit-tested against every one of the re-reviewer's own scenarios,
fixtures only, zero `osascript` calls:** a non-tail insertion (asserts no
drift for untouched items), a non-tail removal (asserts the removed item
is named correctly, not its neighbor), the same removal reproduced against
a fixture matching `02-accounts.js`'s real `{ok, value}`-wrapped shape, the
tail-append case (confirmed to still work), a rename with the value
unchanged (asserts a readable rename line), a rename where the value also
changed (asserts it is NOT merged into one misleadingly-clean rename line),
`outlook` correctly excluded, a pseudonym-stability check against the real
`redact()` function, a check that an identity-keyed path never contains
the pre-redaction original string, and the identity-less-item fallback to
index. `npm test` reports 118 (102 before this fix round plus these 16).

**Re-recording was required, and confirmed.** The path-keying scheme
itself changed (index to identity), so every previously-committed
`successProfile` baseline using the old index-based paths is permanently
incompatible with the new identity-based live computation - verified
directly before re-recording: replaying the old `02-accounts.json`
baseline against a freshly-computed identity-keyed live profile produced a
wall of spurious mismatches (every recorded path "missing," every live
path "new"), exactly the failure mode re-recording exists to avoid.
`02-accounts`, `04-message-props`, and `12-message-sizes` were re-recorded
with their existing stored args unchanged (none, and `0 INBOX`,
respectively); `node research/verify.mjs` returned to `7/7` afterward, with
real timings behind every probe (`04-message-props` and `03-mailboxes`
both taking tens of seconds on this run, not the sub-second timing a
failure-path replay would produce).

## 5. Message identity, in full

This is the section every other document in this archive depends on.
Getting it wrong is what produces intermittent, hard-to-reproduce "message
not found" failures - not because the message moved or was deleted, but
because a caller kept a numeric id and nothing else, and later handed it
back with no way to know which mailbox it came from.

**What `id` is: a per-mailbox integer.** Verified as an integer directly
(`Number.isInteger(m.id())` returned `true`; `typeof m.id()` returned
`"number"`, matching the sdef's `type="integer"`). Apple's own dictionary
describes it tersely - `"The unique identifier of the message."` - with no
mention of any scope at all, which is the misleading part: read on its own,
that description suggests global uniqueness. It is not.

**What `id` is not: unique across mailboxes, or stable across a move.**
`[unverified]` by direct reproduction in this task (reproducing it would
require moving a real message in this mailbox, which the read-only
constraint on this task forbids), but stated as design fact by upstream and
consistent with everything this section did verify. Upstream's own comment,
attached to the cache it built specifically to work around this:

> "Mail.app numeric message ids are unique *per mailbox*, and by-id fetches
> (`getMessageContent`/`getRawSource`) otherwise have to linear-scan every
> mailbox of every account probing `whose id is N`. On a real multi-account
> setup that is 700+ mailboxes; a message in a late-iterated folder (e.g. a
> large 'Sent Items') isn't reached before the AppleScript timeout fires,
> so the fetch returns a false 'not found'..."
> (`src/services/appleMailManager.ts`, comment on `idLocationIndex`)

This is not merely asserted - upstream's own `getMessageById` implements
exactly the scan this comment describes, repeating an id-equality `whose`
test inside a nested loop over every mailbox of every account:

```typescript
repeat with acct in accounts
  repeat with mb in mailboxes of acct
    try
      set matchingMsgs to (messages of mb whose id is ${Number(id)})
      if (count of matchingMsgs) > 0 then
        set msg to item 1 of matchingMsgs
        ...
```

If ids were unique across the whole application, this full double loop
would be pointless - one `whose id is N` against `every message` (if such a
collection existed) would do. That it exists and is exercised in production
is strong indirect evidence for the per-mailbox-uniqueness claim, even
though this task did not independently trigger a genuine id collision
across two mailboxes to prove it directly.

**Why this matters for tool design, stated as concrete rules, each with the
failure it prevents:**

1. **Always return the full mailbox path alongside an id, never the id
   alone.** Without the path, a caller holding only `id: 12345` has no way
   to know which of the account's mailboxes (see section 3 - up to 33
   distinct mailboxes on one account here) that id refers to, and a second
   mailbox could easily have its own, unrelated message numbered 12345.
   Failure this prevents: a lookup that finds the *wrong* message under the
   same id in a different mailbox, silently returning incorrect content
   instead of an error.

2. **Accept an optional account + mailbox hint on any by-id lookup, rather
   than only ever scanning everything.** Upstream's own `idLocationIndex`
   (an in-memory `id -> {account, mailbox}` map, capped at 5,000 entries,
   populated by every prior search/list/fetch) exists specifically to avoid
   the full scan on a repeat lookup - "so a subsequent fetch opens the one
   right mailbox directly. A stale entry (message moved) simply misses and
   falls back to the full scan, so it can never wedge a lookup." Failure
   this prevents when the hint is missing entirely: exactly the "false not
   found" upstream's own comment describes - a real message in a
   late-iterated mailbox is never reached before an AppleScript timeout
   fires, and the tool reports "not found" for a message that exists.

3. **The RFC `message-id` (this document's `messageId()` property, the
   `Message-ID:` header) is the only identifier that survives a move.** A
   numeric `id` is scoped to whichever mailbox the message currently sits
   in; a move changes that scope, and per point 1 there is no guarantee the
   new mailbox's numbering has anything to do with the old one. The
   `Message-ID` header does not change when Mail files a message into a
   different mailbox - it is part of the message's own content, set once by
   whichever mail system created it. Upstream's own
   `findNumericIdByMessageId` exists to convert an RFC message-id back into
   a numeric id when the caller has only the stable identifier and needs
   the fast, mailbox-scoped one - checking `INBOX` first ("swept messages
   live there... to avoid scanning huge All Mail/Archive mailboxes") before
   falling back to every mailbox, and normalizing the bracket form
   (`Mail returns it bracketless; IMAP envelopes carry the brackets`).
   Verified as present and returning a string on this machine's actual
   INBOX message (`research/results/04-message-props.json`,
   `props.messageId`). The redacted recording also corroborates upstream's
   specific "bracketless" claim independently of upstream's own comment:
   the redactor's email-matching pass (`research/redact.mjs`) only
   substitutes the bare address text and leaves any surrounding characters
   - including literal `<`/`>` - untouched, yet the committed
   `props.messageId.sample` shows the pseudonym with no bracket characters
   around it at all. If the raw value had been wrapped in angle brackets,
   they would have survived redaction and be visible in the recording; they
   are not there. `[unverified]` whether every message on this machine has
   a `Message-ID` at all (RFC 5322 does not strictly require it, though
   virtually all real mail carries one in practice) - not tested against a
   message confirmed to lack the header.

**The failure mode when any of this is ignored, stated plainly:**
intermittent, hard-to-reproduce "message not found" errors. Intermittent,
because the id is often still valid - most messages are never moved between
the moment a tool lists them and the moment a caller acts on the id, so the
bug does not show up on the common path. Hard to reproduce, because it
depends on exactly when a move happened relative to the lookup, which
mailbox the tool happens to scan first if it falls back to a full search,
and how many mailboxes exist between the start of that scan and the
message's real, current location - none of which a bug report from a user
is likely to capture. A tool built from this archive should treat "return
a bare numeric id with no path" as a design defect to catch at review time,
not as a bug to debug after a user reports a mysterious failure.

## 6. The `whose` warning

Upstream leans on AppleScript/JXA's `whose` filter clause throughout - the
id-scan in section 5 (`messages of mb whose id is N`), the message-id
lookup (`messages of mb whose message id is ... or message id is ...`),
and, per this project's own `CLAUDE.md`, ordinary text search
(`search-messages`). `whose` is a real, general mechanism (any element
collection - `messages`, `mailboxes`, `accounts` - accepts one), and it is
the only way to ask Mail.app itself to do the filtering rather than
fetching everything and filtering in JavaScript.

**This document does not measure `whose`'s cost - that measurement, and
the head-to-head comparison against a bulk fetch plus a JS-side filter, is
`05-search.md` (Task 6), not yet written at the time of this document.**
What this document *has* measured, and what motivates taking the `whose`
question seriously rather than treating it as a minor style choice, is
section 4's uniform-cost finding: a single-index specifier against a large
mailbox costs seconds, not milliseconds, and a bulk array fetch of the
exact same property across the exact same mailbox costs a few seconds
*total* for all ~17,500 messages. `whose` sits somewhere in between those
two extremes - it is Mail.app doing server/client-side filtering internally
rather than JXA resolving one index - and upstream's own heavy, repeated
use of it throughout `appleMailManager.ts` is the reason Task 6 measures it
directly rather than this document guessing. Treat any specific number
about `whose` you encounter before `05-search.md` exists as `[unverified]`;
cite that document once it does, rather than this one.

## Sources

- `research/probes/02-accounts.js`, `03-mailboxes.js`, `04-message-props.js`,
  `12-message-sizes.js` and their recordings in `research/results/` - every
  measurement in this document not otherwise cited as an ad-hoc command is
  backed by one of these four recordings. `12-message-sizes.js` was
  originally Task 4's probe; this document's fix round 1 converted it (and
  `04-message-props.js`) to the account-selector convention and
  re-recorded both, per "Probe arguments are selectors, never raw names" in
  section 4.
- `research/record.mjs`, `research/redact.mjs`, `research/verify.mjs` - all
  three were modified in this document's fix round 1 (`requireStorableArgs`
  in `record.mjs`; `STANDARD_MAILBOXES` exported from `redact.mjs`;
  `replayReachedOnlyFailurePaths` added to `verify.mjs`), documented in
  full in section 4's "Probe arguments are selectors, never raw names."
- `docs/apple-mail/01-execution-model.md` - the verified/`[unverified]`
  convention this document reuses, and the buffer-limit reasoning section 4
  cites rather than repeats. Its own citation of `research/results/12-message-sizes.json`
  (17,486 messages, recorded by Task 4) is not updated by this document's
  fix round 1 re-recording (17,487 messages, otherwise the same
  distribution) - a one-message drift from real mail arriving between the
  two measurements, left for that document's own maintainers to reconcile
  or not, since correcting another task's already-reviewed citation is
  outside this fix round's scope.
- `docs/superpowers/specs/2026-08-11-mail-mcp-design.md` - the `[Gmail]`
  container / "virtual INBOX" claim quoted and directly contradicted in
  section 3.
- `sdef /System/Applications/Mail.app` (Mail.app 16.0, macOS 26.6.1 build
  25G76) - the class and property listings verified in sections 1, 2, 3,
  and 4. Not committed to this repository (it is a few hundred KB of
  Apple's own dictionary XML with no probe-specific content); reproduce it
  with the command in "How to read this document" rather than looking for a
  saved copy.
- `apple-mail-mcp/src/services/appleMailManager.ts` (the upstream reference
  project this archive is mined from - a sibling checkout, not a
  subdirectory of this repository; cited by repo-relative path, per
  fix round 2, so this citation stays valid regardless of where either
  repository is checked out on disk) - `idLocationIndex`, `getMessageById`,
  `findNumericIdByMessageId`, `disabledAccountGuard`, `isAccountEnabled`
  (message-identity and disabled-account sections). Read-only; no code
  copied, only comments and short script fragments quoted for their design
  rationale.
- `apple-mail-mcp/src/services/imapMultiAccount.ts` - `planCountSources`,
  the exact fix for issue #143 (disabled-account section).
- `apple-mail-mcp/CHANGELOG.md` - issue #143's full entry, including the
  intermittency caveat quoted in the disabled-account section.
- `apple-mail-mcp/CLAUDE.md` - the smart-mailbox plist-editing behavior
  (section 1) and the full-path/ambiguous-leaf-name policy for
  `move-message`/`rename-mailbox`/`delete-mailbox` (section 3), both cited
  as corroboration of what this document independently verified.
- `research/argStorability.mjs`, `research/successProfile.mjs`,
  `research/failurePaths.mjs` and their tests in `research/test/` (all new
  this fix round, extracted from `record.mjs`/`verify.mjs` specifically so
  their logic is unit-testable without a subprocess or a live Mail.app
  call) - the fix-round-2 mechanisms documented in full in section 4's
  "Fix round 2: a shape match still is not enough, and the fix was still
  position-blind."
- `task-5-rereview.md` (this archive's own SDD working directory, not part
  of the committed repository) - the source of every fix-round-2 finding
  addressed in this document; not committed here, so not cited by path,
  only by the findings it produced.
