// Forward draft. Same `without opening window` requirement as reply-draft
// (see that file's header comment); recipients arrive as a JSON array inside
// one argv value, parsed, never interpolated. Nothing here sends.
//
// argv: [accountName, mailboxPath, id, toJson, body]
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

function resolveAccount(Mail, wanted) {
  const all = Mail.accounts();
  const names = all.map((a) => attempt(() => a.name(), "<unreadable>"));
  const matched = [];
  for (var i = 0; i < all.length; i++) if (names[i] === wanted) matched.push(i);
  if (matched.length === 0) {
    return { error: { code: "account-not-found", requested: wanted, candidates: names } };
  }
  const enabledIdx = matched.filter((i) => attempt(() => all[i].enabled(), false) === true);
  if (enabledIdx.length === 0) return { error: { code: "account-disabled", account: wanted } };
  return { account: all[enabledIdx[0]], name: names[enabledIdx[0]] };
}

function resolveMailbox(account, accountName, wantedPath) {
  const segs = wantedPath.split("/");
  let level = attempt(() => account.mailboxes(), null);
  if (level === null) {
    return { error: { code: "mailbox-not-found", requested: wantedPath, account: accountName, candidates: [] } };
  }
  let current = null;
  let prefix = "";
  for (var s = 0; s < segs.length; s++) {
    const seg = segs[s];
    const matches = [];
    for (var b = 0; b < level.length; b++) {
      if (attempt(() => level[b].name(), null) === seg) matches.push(level[b]);
    }
    if (matches.length === 0) {
      const available = level
        .map((x) => attempt(() => x.name(), "<unreadable>"))
        .map((n) => (prefix ? prefix + "/" + n : n));
      return { error: { code: "mailbox-not-found", requested: wantedPath, account: accountName, candidates: available } };
    }
    if (matches.length > 1) {
      const collidingPath = prefix ? prefix + "/" + seg : seg;
      return { error: { code: "mailbox-ambiguous", requested: wantedPath, account: accountName, candidates: matches.map(() => collidingPath) } };
    }
    current = matches[0];
    prefix = prefix ? prefix + "/" + seg : seg;
    if (s < segs.length - 1) level = attempt(() => current.mailboxes(), []);
  }
  return { box: current, path: prefix };
}

function run(argv) {
  const args = argsOf(argv);
  const wantedAccount = args[0];
  const wantedPath = args[1];
  const idNum = Number(args[2]);
  const to = JSON.parse(args[3]);
  const body = args[4];

  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const acct = resolveAccount(Mail, wantedAccount);
  if (acct.error) return JSON.stringify({ ok: false, error: acct.error });
  const mb = resolveMailbox(acct.account, acct.name, wantedPath);
  if (mb.error) return JSON.stringify({ ok: false, error: mb.error });

  const m = mb.box.messages.byId(idNum);
  const realId = attempt(() => m.id(), null);
  if (realId === null) {
    return JSON.stringify({
      ok: false,
      error: { code: "message-not-found", requested: idNum, account: acct.name, mailbox: mb.path },
    });
  }

  const out = Mail.forward(m, { openingWindow: false });
  for (const addr of to) out.toRecipients.push(Mail.ToRecipient({ address: addr }));
  // Same trap as reply-draft.js: set content immediately, never read it
  // first (a prior read makes the set silently no-op on Mail 16.0), and read
  // everything back BEFORE save. Mail appends the forwarded content below.
  // With no note, content is left alone entirely; -1 means "not set here".
  let contentLength = -1;
  if (body.length > 0) {
    out.content = body;
    contentLength = String(attempt(() => out.content(), "")).length;
  }
  const subject = attempt(() => out.subject(), null);
  const to2 = attempt(() => out.toRecipients.address(), []);
  const cc = attempt(() => out.ccRecipients.address(), []);
  const bcc = attempt(() => out.bccRecipients.address(), []);
  Mail.save(out);

  const draft = {
    id: attempt(() => out.id(), null),
    subject: subject,
    to: to2,
    cc: cc,
    bcc: bcc,
    contentLength: contentLength,
  };
  return JSON.stringify({ ok: true, draft: draft });
}
