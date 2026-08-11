// Settles the design spec's inherited Gmail claim by direct measurement,
// per docs/apple-mail/README.md correction 3: the spec says a Gmail account's
// literal INBOX holds roughly nothing and real mail lives in "All Mail" /
// "Important" nested inside a "[Gmail]" container, so a flat lookup fails.
// Prior walks (03-mailboxes) contradicted that, but were not asking this
// question directly. This probe asks it directly, per account:
//   - is the account Gmail-backed at all (server name), independent of the
//     "exposes an All Mail mailbox" heuristic that resolves to nothing here
//   - does a flat byName("INBOX") lookup work, and how much mail is in it
//   - does "All Mail" exist, by flat lookup AND anywhere in a full walk
//   - does "Important" exist anywhere in a full walk
//   - which mailboxes contain other mailboxes (the "[Gmail]"-container claim)
// fetchOk is this probe's ok-style flag (one per account), required so the
// success-profile drift detector has something to protect (03-object-model.md,
// fix round 2 coverage note).
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

function run(argv) {
  argsOf(argv);
  const Mail = Application("Mail");

  const accounts = Mail.accounts().map((a) => {
    const name = attempt(() => a.name(), "<unreadable>");
    const enabled = attempt(() => a.enabled(), false);
    const serverName = String(attempt(() => a.serverName(), "")).toLowerCase();
    const isGmailStyle = serverName.indexOf("gmail") >= 0 || serverName.indexOf("googlemail") >= 0;

    let fetchOk = true;
    let fetchError = "";
    let totalMailboxes = 0;
    let maxDepth = 0;
    let nestedCount = 0;
    const containerNames = [];
    let allMailFound = false;
    let importantFound = false;

    function walk(box, depth) {
      totalMailboxes++;
      if (depth > maxDepth) maxDepth = depth;
      if (depth > 0) nestedCount++;
      const boxName = attempt(() => box.name(), "<unreadable>");
      if (boxName === "All Mail") allMailFound = true;
      if (boxName === "Important") importantFound = true;
      const kids = attempt(() => box.mailboxes(), []);
      if (kids.length > 0) containerNames.push(boxName);
      for (const kid of kids) walk(kid, depth + 1);
    }

    try {
      const boxes = a.mailboxes();
      for (const b of boxes) walk(b, 0);
    } catch (e) {
      fetchOk = false;
      fetchError = String(e);
    }

    // -1 sentinels, matching 03-mailboxes' convention for "could not read".
    const literalInbox = { flatLookupInbox: false, messageCount: -1, unreadCount: -1 };
    try {
      const inbox = a.mailboxes.byName("INBOX");
      literalInbox.messageCount = inbox.messages.length;
      literalInbox.unreadCount = inbox.unreadCount();
      literalInbox.flatLookupInbox = true;
    } catch (e) {
      // Disabled accounts have zero mailboxes; the sentinels say so.
    }

    const flatLookupAllMail = attempt(() => {
      a.mailboxes.byName("All Mail").name();
      return true;
    }, false);

    return {
      name: name,
      enabled: enabled,
      isGmailStyle: isGmailStyle,
      fetchOk: fetchOk,
      fetchError: fetchError,
      totalMailboxes: totalMailboxes,
      maxDepth: maxDepth,
      nestedCount: nestedCount,
      containerNames: containerNames,
      literalInbox: literalInbox,
      allMail: { flatLookupAllMail: flatLookupAllMail, found: allMailFound },
      important: { found: importantFound },
    };
  });

  return JSON.stringify({ accounts: accounts });
}
