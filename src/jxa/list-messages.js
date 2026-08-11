// Newest N messages of one mailbox: bulk property arrays plus a JS sort and
// slice. Never an index specifier (seconds per property on a 17k mailbox,
// does not finish on 52k) and never a `whose` clause (27.85s vs 5.19s for
// the same 19 results, measured). The size guard is mandatory: bulk fetch
// degrades worse than linearly with mailbox size.
//
// argv: [accountName, mailboxPath, limit, maxMessages]
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

// Validate against enumerated names BEFORE any use: Mail's -1728 names no
// object and cannot be recovered into a useful message afterwards.
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

// Resolve a full path segment by segment against enumerated children. Zero
// and multiple matches are both real outcomes (same-named siblings exist on
// this machine) and are reported, never guessed away.
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

function toIso(d) {
  return d instanceof Date ? d.toISOString() : String(d);
}

function run(argv) {
  const args = argsOf(argv);
  const wantedAccount = args[0];
  const wantedPath = args[1];
  const limit = Number(args[2]);
  const maxMessages = Number(args[3]);

  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const acct = resolveAccount(Mail, wantedAccount);
  if (acct.error) return JSON.stringify({ ok: false, error: acct.error });
  const mb = resolveMailbox(acct.account, acct.name, wantedPath);
  if (mb.error) return JSON.stringify({ ok: false, error: mb.error });

  const n = mb.box.messages.length;
  if (n > maxMessages) {
    return JSON.stringify({
      ok: false,
      error: { code: "mailbox-too-large", account: acct.name, requested: mb.path, messageCount: n, maxMessages: maxMessages },
    });
  }
  if (n === 0) return JSON.stringify({ ok: true, messageCount: 0, messages: [] });

  const msgs = mb.box.messages;
  const ids = msgs.id();
  const messageIds = msgs.messageId();
  const subjects = msgs.subject();
  const senders = msgs.sender();
  const dates = msgs.dateReceived();
  const readFlags = msgs.readStatus();

  // Mail arriving mid-call would shift later arrays against earlier ones and
  // silently mis-associate every property. Refuse instead; the caller retries.
  for (const arr of [messageIds, subjects, senders, dates, readFlags]) {
    if (arr.length !== ids.length) {
      throw new Error("mailbox contents changed during the read; retry");
    }
  }

  const order = ids.map((_, i) => i);
  order.sort((x, y) => dates[y] - dates[x]);

  const messages = order.slice(0, limit).map((i) => ({
    id: ids[i],
    messageId: messageIds[i],
    subject: subjects[i],
    sender: senders[i],
    dateReceived: toIso(dates[i]),
    read: readFlags[i],
    mailbox: mb.path,
    account: acct.name,
  }));

  return JSON.stringify({ ok: true, messageCount: n, messages: messages });
}
