// Settles the recipe get-message/get-thread rest on: messages.byId(N) against
// a KNOWN mailbox resolves in milliseconds, unlike an index specifier
// (messages[i]), whose per-property cost is seconds on a ~17k mailbox and
// which did not finish in 240s on the 52k one (03-object-model.md section 4).
// byId is a formUniqueID specifier; the uniform-cost trap is specific to
// positional access. Also verifies a byId MISS raises quickly and loudly,
// which is what get-message's message-not-found path depends on.
//
// argv: [account selector (index / largest-enabled / gmail-style), mailbox]
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

function resolveAccount(Mail, selector) {
  const accounts = Mail.accounts();
  if (/^\d+$/.test(selector)) {
    const idx = Number(selector);
    if (idx >= accounts.length) {
      throw new Error(`account selector index ${idx} is out of range (0..${accounts.length - 1})`);
    }
    return accounts[idx];
  }
  if (selector === "largest-enabled") {
    let best = null;
    let bestCount = -1;
    for (const a of accounts) {
      let enabled = false;
      try { enabled = a.enabled(); } catch (e) { enabled = false; }
      if (!enabled) continue;
      let count = -1;
      try { count = a.mailboxes.byName("INBOX").messages.length; } catch (e) { count = -1; }
      if (count > bestCount) { bestCount = count; best = a; }
    }
    if (!best) throw new Error('selector "largest-enabled": no enabled account with a readable INBOX was found');
    return best;
  }
  throw new Error(`unknown account selector "${selector}"`);
}

function run(argv) {
  const [accountSelector, mailboxName] = argsOf(argv);
  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const out = {
    fetchOk: false,
    fetchError: "",
    messageCount: -1,
    bulkIdSeconds: -1,
    byIdSubjectSeconds: -1,
    byIdHeadersBulkSeconds: -1,
    byIdMissRaised: false,
    byIdMissSeconds: -1,
  };

  try {
    const account = resolveAccount(Mail, accountSelector);
    const box = account.mailboxes.byName(mailboxName);

    let t0 = $.NSDate.date;
    const ids = box.messages.id();
    out.bulkIdSeconds = $.NSDate.date.timeIntervalSinceDate(t0);
    out.messageCount = ids.length;
    if (ids.length === 0) throw new Error("mailbox is empty; nothing to time byId against");

    const m = box.messages.byId(ids[Math.floor(ids.length / 2)]);
    t0 = $.NSDate.date;
    m.subject();
    out.byIdSubjectSeconds = $.NSDate.date.timeIntervalSinceDate(t0);

    t0 = $.NSDate.date;
    m.headers.name();
    out.byIdHeadersBulkSeconds = $.NSDate.date.timeIntervalSinceDate(t0);

    t0 = $.NSDate.date;
    try {
      box.messages.byId(999999999).subject();
    } catch (e) {
      out.byIdMissRaised = true;
    }
    out.byIdMissSeconds = $.NSDate.date.timeIntervalSinceDate(t0);

    out.fetchOk = true;
  } catch (e) {
    out.fetchError = String(e);
  }

  return JSON.stringify(out);
}
