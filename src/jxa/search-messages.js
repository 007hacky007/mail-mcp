// Substring search: bulk-fetch only the property arrays the query needs and
// filter in JS. Never `whose` (27.85s vs 5.19s measured for the same 19
// results). Scans every target mailbox under the size guard and reports both
// what was scanned and what was skipped, so an empty result is never
// ambiguous between "nothing matched" and "we gave up".
//
// argv: [accountName or "", mailboxPath or "", query or "", fieldsCsv,
//        dateFromIso or "", dateToIso or "", limit, maxMessages]
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

function collectBoxes(account, accountName, out) {
  function walk(box, prefix) {
    const name = attempt(() => box.name(), "<unreadable>");
    const path = prefix ? prefix + "/" + name : name;
    out.push({ box: box, path: path, accountName: accountName });
    const kids = attempt(() => box.mailboxes(), []);
    for (const kid of kids) walk(kid, path);
  }
  for (const b of attempt(() => account.mailboxes(), [])) walk(b, "");
}

function toIso(d) {
  return d instanceof Date ? d.toISOString() : String(d);
}

function run(argv) {
  const args = argsOf(argv);
  const wantedAccount = args[0] || "";
  const wantedPath = args[1] || "";
  const query = (args[2] || "").toLowerCase();
  const fields = (args[3] || "subject,sender").split(",").filter(Boolean);
  const dateFrom = args[4] ? new Date(args[4]) : null;
  const dateTo = args[5] ? new Date(args[5]) : null;
  const limit = Number(args[6]);
  const maxMessages = Number(args[7]);

  const wantSubject = fields.indexOf("subject") >= 0;
  const wantSender = fields.indexOf("sender") >= 0;

  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  // Build the target mailbox list from the requested scope.
  const targets = [];
  if (wantedAccount) {
    const acct = resolveAccount(Mail, wantedAccount);
    if (acct.error) return JSON.stringify({ ok: false, error: acct.error });
    if (wantedPath) {
      const mb = resolveMailbox(acct.account, acct.name, wantedPath);
      if (mb.error) return JSON.stringify({ ok: false, error: mb.error });
      targets.push({ box: mb.box, path: mb.path, accountName: acct.name });
    } else {
      collectBoxes(acct.account, acct.name, targets);
    }
  } else {
    const all = Mail.accounts();
    for (var i = 0; i < all.length; i++) {
      if (attempt(() => all[i].enabled(), false) !== true) continue;
      const accountName = attempt(() => all[i].name(), "<unreadable>");
      collectBoxes(all[i], accountName, targets);
    }
  }

  const hits = [];
  const scanned = [];
  const skipped = [];

  for (const t of targets) {
    try {
      const n = t.box.messages.length;
      if (n === 0) {
        scanned.push({ account: t.accountName, path: t.path, messageCount: 0 });
        continue;
      }
      if (n > maxMessages) {
        skipped.push({ account: t.accountName, path: t.path, messageCount: n, reason: "over-size-guard" });
        continue;
      }
      const msgs = t.box.messages;
      const ids = msgs.id();
      const dates = msgs.dateReceived();
      const subjects = wantSubject ? msgs.subject() : null;
      const senders = wantSender ? msgs.sender() : null;
      for (const arr of [dates, subjects, senders]) {
        if (arr && arr.length !== ids.length) {
          throw new Error("mailbox contents changed during the read; retry");
        }
      }
      for (var m = 0; m < ids.length; m++) {
        if (dateFrom && dates[m] < dateFrom) continue;
        if (dateTo && dates[m] > dateTo) continue;
        if (query) {
          let matched = false;
          if (subjects && String(subjects[m]).toLowerCase().indexOf(query) >= 0) matched = true;
          if (!matched && senders && String(senders[m]).toLowerCase().indexOf(query) >= 0) matched = true;
          if (!matched) continue;
        }
        hits.push({
          id: ids[m],
          subject: subjects ? subjects[m] : null,
          sender: senders ? senders[m] : null,
          dateReceived: toIso(dates[m]),
          mailbox: t.path,
          account: t.accountName,
          sortKey: dates[m] instanceof Date ? dates[m].getTime() : 0,
        });
      }
      scanned.push({ account: t.accountName, path: t.path, messageCount: n });
    } catch (e) {
      skipped.push({ account: t.accountName, path: t.path, messageCount: -1, reason: "error: " + String(e) });
    }
  }

  hits.sort((a, b) => b.sortKey - a.sortKey);
  const matchCount = hits.length;
  const truncated = matchCount > limit;
  const top = hits.slice(0, limit).map((h) => ({
    id: h.id,
    subject: h.subject,
    sender: h.sender,
    dateReceived: h.dateReceived,
    mailbox: h.mailbox,
    account: h.account,
  }));

  return JSON.stringify({
    ok: true,
    hits: top,
    matchCount: matchCount,
    truncated: truncated,
    scanned: scanned,
    skipped: skipped,
  });
}
