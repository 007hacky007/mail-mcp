// Reply draft. `reply ... without opening window` is MANDATORY, not a
// preference: with a compose window, `set content` silently no-ops because
// the window is not ready, producing an empty body - specifically from
// background processes, which is how an MCP server always runs (upstream
// issue #7; no amount of delay fixes it). The saved draft's content length
// is read back and reported so the caller can verify the body stuck.
//
// argv: [accountName, mailboxPath, id, body, replyAll "true"/"false"]
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
  const body = args[3];
  const replyAll = args[4] === "true";

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

  const out = Mail.reply(m, { openingWindow: false, replyToAll: replyAll });
  // Set content IMMEDIATELY and never read it first: measured on Mail 16.0,
  // a prior content() read poisons the object and the set silently no-ops,
  // saving the bare quote skeleton without the body - even without a compose
  // window. Mail appends the quoted original below this content on save, so
  // nothing needs to be concatenated here. Post-save reads through this
  // object are also unreliable (content reads back empty), so every field is
  // read back BEFORE save, except id.
  out.content = body;
  const readBack = String(attempt(() => out.content(), ""));
  const subject = attempt(() => out.subject(), null);
  const to = attempt(() => out.toRecipients.address(), []);
  const cc = attempt(() => out.ccRecipients.address(), []);
  const bcc = attempt(() => out.bccRecipients.address(), []);
  Mail.save(out);

  const draft = {
    id: attempt(() => out.id(), null),
    subject: subject,
    to: to,
    cc: cc,
    bcc: bcc,
    contentLength: readBack.length,
  };
  return JSON.stringify({ ok: true, draft: draft });
}
