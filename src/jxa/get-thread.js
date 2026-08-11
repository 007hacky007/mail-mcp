// Groups messages related to a seed message. Primary grouping is the RFC
// References / In-Reply-To chain read from the seed's headers; normalized
// subject is both the fallback (when the seed carries no references) and a
// supplement (References only names ancestors, so sibling and descendant
// replies are reachable by subject). Every message says which rule matched
// it, and the whole result says which grouping produced it.
//
// argv: [accountName, mailboxPath, id, maxMessages]
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
  return d instanceof Date ? d.toISOString() : d === null ? null : String(d);
}

// Strip any pile of reply/forward prefixes: "Re: Fwd: Re: x" -> "x".
function normalizeSubject(s) {
  let out = String(s || "").trim();
  const prefix = /^(re|fwd?|fw|aw|sv|odp)\s*(\[\d+\])?\s*:\s*/i;
  while (prefix.test(out)) out = out.replace(prefix, "");
  return out.toLowerCase().trim();
}

function run(argv) {
  const args = argsOf(argv);
  const wantedAccount = args[0];
  const wantedPath = args[1];
  const idNum = Number(args[2]);
  const maxMessages = Number(args[3]);

  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const acct = resolveAccount(Mail, wantedAccount);
  if (acct.error) return JSON.stringify({ ok: false, error: acct.error });
  const mb = resolveMailbox(acct.account, acct.name, wantedPath);
  if (mb.error) return JSON.stringify({ ok: false, error: mb.error });

  const seed = mb.box.messages.byId(idNum);
  const seedId = attempt(() => seed.id(), null);
  if (seedId === null) {
    return JSON.stringify({
      ok: false,
      error: { code: "message-not-found", requested: idNum, account: acct.name, mailbox: mb.path },
    });
  }

  const seedMessageId = String(attempt(() => seed.messageId(), "") || "");
  const seedSubject = attempt(() => seed.subject(), "");
  const seedNorm = normalizeSubject(seedSubject);

  // References/In-Reply-To from the seed's headers, bracket forms normalized
  // to Mail's bracketless messageId convention.
  const headerNames = attempt(() => seed.headers.name(), []);
  const headerValues = attempt(() => seed.headers.content(), []);
  const refs = {};
  let refCount = 0;
  for (var h = 0; h < Math.min(headerNames.length, headerValues.length); h++) {
    const lower = String(headerNames[h]).toLowerCase();
    if (lower !== "references" && lower !== "in-reply-to") continue;
    const tokens = String(headerValues[h]).match(/<[^>]+>/g) || [];
    for (const token of tokens) {
      refs[token.slice(1, -1)] = true;
      refCount++;
    }
  }
  if (seedMessageId) refs[seedMessageId] = true;
  const groupedBy = refCount > 0 ? "references" : "subject";

  const targets = [];
  collectBoxes(acct.account, acct.name, targets);

  const messages = [
    {
      id: seedId,
      messageId: seedMessageId || null,
      subject: seedSubject,
      sender: attempt(() => seed.sender(), null),
      dateReceived: toIso(attempt(() => seed.dateReceived(), null)),
      mailbox: mb.path,
      account: acct.name,
      matchedBy: "seed",
      sortKey: attempt(() => seed.dateReceived().getTime(), 0),
    },
  ];
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
      const messageIds = msgs.messageId();
      const subjects = msgs.subject();
      const senders = msgs.sender();
      const dates = msgs.dateReceived();
      for (const arr of [messageIds, subjects, senders, dates]) {
        if (arr.length !== ids.length) {
          throw new Error("mailbox contents changed during the read; retry");
        }
      }
      for (var m = 0; m < ids.length; m++) {
        if (t.path === mb.path && ids[m] === seedId) continue; // seed already included
        const byRef = refs[String(messageIds[m])] === true;
        const bySubject = seedNorm !== "" && normalizeSubject(subjects[m]) === seedNorm;
        if (!byRef && !bySubject) continue;
        messages.push({
          id: ids[m],
          messageId: messageIds[m],
          subject: subjects[m],
          sender: senders[m],
          dateReceived: toIso(dates[m]),
          mailbox: t.path,
          account: t.accountName,
          matchedBy: byRef && bySubject ? "both" : byRef ? "references" : "subject",
          sortKey: dates[m] instanceof Date ? dates[m].getTime() : 0,
        });
      }
      scanned.push({ account: t.accountName, path: t.path, messageCount: n });
    } catch (e) {
      skipped.push({ account: t.accountName, path: t.path, messageCount: -1, reason: "error: " + String(e) });
    }
  }

  messages.sort((a, b) => a.sortKey - b.sortKey);
  for (const msg of messages) delete msg.sortKey;

  return JSON.stringify({
    ok: true,
    groupedBy: groupedBy,
    seed: { id: seedId, mailbox: mb.path, account: acct.name },
    messages: messages,
    scanned: scanned,
    skipped: skipped,
  });
}
