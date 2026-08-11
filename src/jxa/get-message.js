// One message, reached by id within a KNOWN mailbox. byId is a formUniqueID
// specifier and resolves in milliseconds even on a 52k mailbox (recorded,
// research/results/13-byid.json), unlike positional access which does not
// finish there. `source` is fetched ONLY when the caller asked for HTML:
// fetching it unconditionally is how upstream returned raw MIME blobs, and
// a source can be tens of megabytes.
//
// argv: [accountName, mailboxPath, id, includeHtml "true"/"false"]
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

function toIso(d) {
  return d instanceof Date ? d.toISOString() : d === null ? null : String(d);
}

function zipRecipients(names, addresses) {
  const out = [];
  for (var i = 0; i < Math.max(names.length, addresses.length); i++) {
    out.push({ name: names[i] !== undefined ? names[i] : null, address: addresses[i] !== undefined ? addresses[i] : null });
  }
  return out;
}

function run(argv) {
  const args = argsOf(argv);
  const wantedAccount = args[0];
  const wantedPath = args[1];
  const idNum = Number(args[2]);
  const includeHtml = args[3] === "true";

  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const acct = resolveAccount(Mail, wantedAccount);
  if (acct.error) return JSON.stringify({ ok: false, error: acct.error });
  const mb = resolveMailbox(acct.account, acct.name, wantedPath);
  if (mb.error) return JSON.stringify({ ok: false, error: mb.error });

  const m = mb.box.messages.byId(idNum);
  // A byId miss raises on first property access, in milliseconds (recorded).
  const realId = attempt(() => m.id(), null);
  if (realId === null) {
    return JSON.stringify({
      ok: false,
      error: { code: "message-not-found", requested: idNum, account: acct.name, mailbox: mb.path },
    });
  }

  const headerNames = attempt(() => m.headers.name(), []);
  const headerValues = attempt(() => m.headers.content(), []);
  const headers = [];
  for (var h = 0; h < Math.min(headerNames.length, headerValues.length); h++) {
    headers.push({ name: headerNames[h], value: headerValues[h] });
  }

  const message = {
    id: realId,
    messageId: attempt(() => m.messageId(), null),
    subject: attempt(() => m.subject(), null),
    sender: attempt(() => m.sender(), null),
    replyTo: attempt(() => m.replyTo(), null),
    dateReceived: toIso(attempt(() => m.dateReceived(), null)),
    dateSent: toIso(attempt(() => m.dateSent(), null)),
    read: attempt(() => m.readStatus(), null),
    flagged: attempt(() => m.flaggedStatus(), null),
    sizeBytes: attempt(() => m.messageSize(), null),
    to: zipRecipients(attempt(() => m.toRecipients.name(), []), attempt(() => m.toRecipients.address(), [])),
    cc: zipRecipients(attempt(() => m.ccRecipients.name(), []), attempt(() => m.ccRecipients.address(), [])),
    headers: headers,
    textBody: String(attempt(() => m.content(), "")),
    mailbox: mb.path,
    account: acct.name,
  };

  const out = { ok: true, message: message };
  if (includeHtml) out.source = String(attempt(() => m.source(), ""));
  return JSON.stringify(out);
}
