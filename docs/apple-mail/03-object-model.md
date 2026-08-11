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
a Gmail construct. `[unverified]` whether this is a property of this
specific Gmail account's folder configuration, of how this Mail.app version
presents Gmail IMAP folders, or something else - a future task
(`08-quirks-and-traps.md`, which already reserves probe fields for exactly
this - `isGmailStyle`, `literalInbox`, `allMail`, `containerNames`) is where
Gmail-specific structure gets its own dedicated measurement. The concrete,
load-bearing fact for *this* document is narrower and fully verified: this
probe's generic recursive walk needs no Gmail-specific logic at all, and a
document that assumed a `[Gmail]` container would exist and coded around
it would have coded around something that, on real hardware, is not there.

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
04-message-props "<enabled account>" INBOX`). This probe reads **one**
message (`box.messages[0]`) and times each property individually,
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
one." **Measurement, repeated three times against the same 17,486-message
INBOX, refutes this cleanly:**

| Run | Range across all 17 properties | `id` | `source` (via `sourceLength`) |
|---|---|---|---|
| Committed recording (`research/results/04-message-props.json`) | 0.480s - 2.366s | 1.697s | 0.735s |
| Ad-hoc confirmation run 1 | 1.489s - 3.217s | 1.789s | 1.712s |
| Ad-hoc confirmation run 2 | 1.383s - 1.987s | 1.458s | 1.692s |

In every run, `source` sits comfortably inside the same range as trivial,
tiny properties like `id`, `flagIndex`, and `attachmentCount` - it is never
the outlier. The dominant cost is not the property being read; it is
resolving `box.messages[0]` - an *index specifier* - against a mailbox with
17,486 messages, paid again on every single top-level property call inside
this probe's `run()`, because JXA does not cache that resolution between
separate synchronous calls in the same script.

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
| Single-index specifier (`messages[0]`), large mailbox (17,486 messages) | 0.48-3.2s per property, uniformly - no property is a clear outlier | this section's three runs |
| Bulk array fetch (`mailbox.messages.messageSize()`), same 17,486-message mailbox, all messages at once | 2.064s **total**, for **all 17,486** values - about 0.12ms per message | `research/results/12-message-sizes.json` (Task 4's recording; cited, not re-measured here) |

The last row is the most important number in this document: reading one
property for one message via an index specifier on this mailbox costs
roughly **13,000 to 19,000 times more per message** than reading the same
property for every message via a bulk array fetch (about 1.5-2.4 seconds
for 1 message versus about 0.00012 seconds per message in a fetch of
17,486). This previews, but does not replace, the dedicated measurement a
later document (`05-search.md`, Task 6) makes of bulk fetch versus `whose`
- see section 6.

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

### A fingerprint-noise trap this task found and fixed inside its own probe

This project's redaction/verification machinery
(`research/redact.mjs`/`research/verify.mjs`) is explicitly designed to
warn about a property that "sometimes serializes as `null` and sometimes
is omitted entirely" producing spurious shape mismatches. Building this
section's own probe surfaced exactly that trap, concretely, not
hypothetically:

The `timed()` helper's original (brief-verbatim) failure branch was
`{ ok: false, seconds, error }` - three keys - while its success branch was
`{ ok: true, seconds, type, sample }` - four different keys. Both branches
are individually reasonable. The problem is that `research/verify.mjs`
replays a probe using its **recorded, already-redacted `args`** -
`record.mjs` redacts non-standard account/mailbox names in `args` before
writing them to disk (see `research/redact.mjs`), so a verify run for this
probe always calls it with an opaque placeholder string like
`"<str len=5 chars=ascii>"`, never the real account/mailbox name.
`Mail.accounts.byName(placeholder)` does not throw immediately in JXA (it
resolves lazily), but every subsequent `m.xxx()` property call inside
`timed()` then throws - which flips **every single property, on every
verify run, with certainty** from the success shape to the failure shape.
Running `node research/verify.mjs` against the brief-verbatim version of
this probe reproduced exactly that, for real:

```
FAIL 04-message-props:
  props.attachmentCount.sample: missing (was number)
  props.attachmentCount.type: missing (was string)
  props.attachmentCount.error: added (string)
  ... (repeated for all 17 properties)
6/7 probes match their recorded shape
```

Fixed by making both branches of `timed()` emit the identical key set with
values of the identical JS type regardless of outcome - `{ok, seconds,
type, sample, error}`, always all five keys, `sample` always coerced to a
string (`String(value)` rather than passing a number/boolean through
natively) so its type cannot vary by property or by success/failure. No
change to `research/redact.mjs`'s allowlist was needed - all five keys were
already present, since the brief's own design already anticipated most of
them. After the fix: `node research/verify.mjs` reports `7/7`. The general
lesson, stated for whoever writes the next probe: a timing/attempt wrapper
used inside a probe must emit a shape-stable result on both its success and
failure branches, or the probe's shape becomes a function of whether *this
particular replay's inputs happened to succeed* rather than of the object
model - defeating the entire purpose of a shape-based regression check. See
also `research/probes/12-message-sizes.js`'s header comment, which
independently documents the same lesson for a different probe.

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
*total* for all 17,486 messages. `whose` sits somewhere in between those
two extremes - it is Mail.app doing server/client-side filtering internally
rather than JXA resolving one index - and upstream's own heavy, repeated
use of it throughout `appleMailManager.ts` is the reason Task 6 measures it
directly rather than this document guessing. Treat any specific number
about `whose` you encounter before `05-search.md` exists as `[unverified]`;
cite that document once it does, rather than this one.

## Sources

- `research/probes/02-accounts.js`, `03-mailboxes.js`, `04-message-props.js`
  and their recordings in `research/results/` - every measurement in this
  document not otherwise cited as an ad-hoc command is backed by one of
  these three recordings.
- `research/results/12-message-sizes.json` (Task 4's recording) - the bulk
  `messageSize` distribution and the 2.064s/17,486-value bulk-fetch timing
  cited in section 4, reused rather than re-measured, per this task's
  instructions.
- `docs/apple-mail/01-execution-model.md` - the verified/`[unverified]`
  convention this document reuses, and the buffer-limit reasoning section 4
  cites rather than repeats.
- `sdef /System/Applications/Mail.app` (Mail.app 16.0, macOS 26.6.1 build
  25G76) - the class and property listings verified in sections 1, 2, 3,
  and 4. Not committed to this repository (it is a few hundred KB of
  Apple's own dictionary XML with no probe-specific content); reproduce it
  with the command in "How to read this document" rather than looking for a
  saved copy.
- `../apple-mail-mcp/src/services/appleMailManager.ts`
  - `idLocationIndex`, `getMessageById`, `findNumericIdByMessageId`,
  `disabledAccountGuard`, `isAccountEnabled` (message-identity and
  disabled-account sections). Read-only; no code copied, only comments and
  short script fragments quoted for their design rationale.
- `../apple-mail-mcp/src/services/imapMultiAccount.ts`
  - `planCountSources`, the exact fix for issue #143 (disabled-account
  section).
- `../apple-mail-mcp/CHANGELOG.md` - issue #143's
  full entry, including the intermittency caveat quoted in the
  disabled-account section.
- `../apple-mail-mcp/CLAUDE.md` - the smart-mailbox
  plist-editing behavior (section 1) and the full-path/ambiguous-leaf-name
  policy for `move-message`/`rename-mailbox`/`delete-mailbox` (section 3),
  both cited as corroboration of what this document independently verified.
