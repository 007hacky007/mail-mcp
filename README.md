# mail-mcp

An Apple Mail MCP server with a supply chain small enough to read in an
afternoon: zero runtime dependencies, no network code, no shell, and no way
to send mail. It drives Mail.app through its scripting interface (JXA over
`osascript`) and exposes thirteen tools for reading mail, listing structure,
handling attachments, and creating drafts.

Everything load-bearing here traces to measurements on real hardware,
recorded in `docs/apple-mail/` and re-checkable with `node research/verify.mjs`.

## The security posture, stated plainly

**This server cannot send mail, and that is the design, not a gap.**

- There is no send tool, no send code path, and no code that could grow one
  quietly: a test walks the dependency closure and fails if anything imports
  `node:net`, `node:tls`, `node:http`, `node:https`, `node:dgram`, calls
  `fetch`, or contains a `send(` call in a Mail script. Do not add a send
  tool; a draft-then-send flow with an in-band confirmation token does not
  actually establish human review, because a model can chain both calls in
  one turn. The user reviews drafts in Mail.app and presses Send there.
- Drafts are the only mutation. No delete, no move, no mark-as-read, no rule
  editing. Email content is attacker-controlled input to any model reading
  it; the small write surface bounds what injected instructions can do.
- No credentials, no sockets, no Keychain. Mail.app does its own syncing;
  this server never sees a password or opens a connection.
- `save-attachment` is the only filesystem writer. It writes only under an
  allowlisted root (`MAIL_MCP_SAVE_ROOT`, default `~/Downloads`), resolves
  symlinks before checking containment, sanitizes filenames from mail, and
  never overwrites. There is deliberately no tool that returns attachment
  bytes into the conversation.
- No user value is ever interpolated into script text. Scripts are static
  files on disk; values travel as `argv`, spawned without a shell.
- `package.json` has no `dependencies` key. Ever. A test enforces this too.

## Requirements

- macOS with Mail.app configured (built against Mail 16.0 on macOS 26.x)
- Node.js 20 or newer
- Automation permission for whatever runs the server (see below)

## Install and register

No build step and no dependencies to install. Clone the repository and
register the entry point with your MCP host. For Claude Code:

```bash
claude mcp add mail-mcp -- node /absolute/path/to/mail-mcp/src/index.mjs
```

For any other host, configure a stdio server running
`node /absolute/path/to/mail-mcp/src/index.mjs`.

### Automation permission

On the first call into Mail, macOS prompts to allow the host application to
control Mail.app. Approve it. To check or repair the grant: System Settings >
Privacy & Security > Automation, find the host app (Terminal, Claude, etc.),
enable Mail. The `doctor` tool reports whether the grant is working.

### The ad-hoc-signed Node problem

TCC identifies programs by code signature. A Homebrew-installed Node is
ad-hoc signed and its signature changes on every upgrade, so macOS forgets
the Automation grant and prompts again after each `brew upgrade`. If the
re-prompting bothers you, use the official Node.js installer (Developer ID
signed, stable identity) at a stable path. `doctor` reports which kind of
Node is running.

## Tools

| Tool | What it does |
|------|--------------|
| `doctor` | Diagnostics: Mail running, Automation granted, accounts visible, Node signing, warm round-trip timing. Run first when anything misbehaves. |
| `list-accounts` | Accounts with enabled state, type, addresses. Disabled accounts are reported as disabled, never hidden. |
| `list-mailboxes` | Mailbox tree with full paths and (optionally) counts. Full paths are the identifiers everything else expects. |
| `get-unread-count` | Cheap unread counts; defaults to every enabled account's INBOX. |
| `list-messages` | Newest N of one mailbox: id, subject, sender, date, read state, mailbox path. |
| `search-messages` | Substring search over subject/sender with date range, across accounts or scoped. Reports every mailbox scanned and skipped. |
| `get-message` | One message in full: headers, recipients, plain-text body; `includeHtml` opt-in fetches and parses the source for the HTML part. |
| `get-thread` | Related messages via References/In-Reply-To, with visible normalized-subject fallback. |
| `list-attachments` | Attachment names, types, sizes, parsed from the MIME source. Metadata only. |
| `save-attachment` | Writes one attachment under the allowlisted root. Never overwrites. |
| `create-draft` | New draft with recipients, subject, body, optional attachments. Saved to Drafts, never sent. |
| `reply-draft` | Reply (or reply-all) draft with your body above the quoted original. Never sent. |
| `forward-draft` | Forward draft to given recipients with an optional note. Never sent. |

## Things worth knowing before filing a bug

- **Message ids are per-mailbox integers and do not survive moves.** Every
  tool returns the full mailbox path with the id, and lookups need both. If
  a message was moved since you listed it, re-list or search again.
- **Size guards are deliberate.** Bulk reads degrade worse than linearly
  with mailbox size (measured: a 52k-message mailbox is far more than 3x
  slower than a 17k one). Mailboxes over the guard are refused or skipped
  and reported, never silently dropped. Raise `maxMessages` per call to scan
  them anyway and expect tens of seconds.
- **Search covers subject and sender, not bodies.** Fetching every body
  through the scripting bridge would take minutes and gigabytes.
- **A failed operation never looks like an empty result.** Transport
  failures (Mail unresponsive, timeout) surface as errors; domain refusals
  name the real candidates; partial scans label their totals as floors and
  list what was skipped.
- **Ambiguity is refused, not guessed.** Real mailboxes can have two
  same-named siblings (this machine has twin `Junk` mailboxes in one
  account); a path matching more than one mailbox is an error naming them.
- **Gmail accounts may hide standard mailboxes from the scripting bridge.**
  On this machine the Gmail-backed account exposes no `All Mail`, no
  `[Gmail]` container, and no `Drafts` mailbox; its INBOX is real and holds
  the mail. Created drafts for such an account exist in Mail's unified
  Drafts even when no per-account Drafts path can list them.

## Configuration

| Variable | Meaning | Default |
|----------|---------|---------|
| `MAIL_MCP_SAVE_ROOT` | Root directory `save-attachment` may write under | `~/Downloads` |

## Testing

```bash
npm test                  # tier 1: 219 unit tests, no Mail.app, runs anywhere
node research/verify.mjs  # tier 2: replays every recorded probe against real Mail
```

Tier 1 gates every commit: input guards, MIME parsing, path containment,
error mapping, and the no-network/no-send/no-deps enforcement tests. Tier 2
is the drift detector: it fails when a macOS update changes Mail's object
model or performance characteristics that this design rests on (bulk fetch,
`byId` cost, mailbox structure).

Tier 3 is drafts: creating them is the only mutation, so automated runs are
manual-by-choice. The live checklist used during development is described in
`docs/apple-mail/README.md` (draft recipes section); it creates clearly
labeled test drafts that you delete afterwards.

## Architecture

```
src/mcp/     stdio JSON-RPC framing: initialize, tools/list, tools/call
src/tools/   one file per tool: validate input, call, shape output
src/mail/    domain logic that runs in Node: MIME parsing, path containment
src/jxa/     the runner plus one .js script per operation, run via osascript
```

Scripts are ordinary files, independently runnable from a terminal for
debugging (`osascript -l JavaScript src/jxa/list-accounts.js`). The runner
serializes all Mail calls (Mail's scripting dispatch is single-threaded),
charges queue wait against each call's own deadline, kills overruns with
SIGKILL, and treats non-JSON output as a transport failure, never as data.

The knowledge behind every design decision lives in `docs/apple-mail/`:
measured costs, the `whose`-clause trap, message identity semantics, the
draft-content trap, and the corrections to folklore that turned out to be
wrong on real hardware.

## License

No license granted yet. All rights reserved.
