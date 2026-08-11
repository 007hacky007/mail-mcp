// Unread counts without the expensive path: Mail caches unreadCount, so this
// is a handful of Apple Events, never a message walk.
//
// argv: [accountName or "" for all enabled accounts,
//        mailboxPath or "" meaning INBOX]
//
// Path resolution enumerates each level and matches segments in JS. Zero
// matches and multiple matches are both real outcomes (same-named siblings
// exist on this machine) and are reported structurally, never guessed away.
function argsOf(argv) {
  return argv[0] === "--" ? argv.slice(1) : argv;
}
function attempt(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

function run(argv) {
  const args = argsOf(argv);
  const wantedAccount = args[0] || "";
  const wantedPath = args[1] || "INBOX";

  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const all = Mail.accounts();
  const names = all.map((a) => attempt(() => a.name(), "<unreadable>"));
  const enabledFlags = all.map((a) => attempt(() => a.enabled(), false));

  let scoped = [];
  if (wantedAccount) {
    for (var i = 0; i < all.length; i++) if (names[i] === wantedAccount) scoped.push(i);
    if (scoped.length === 0) {
      return JSON.stringify({
        ok: false,
        error: { code: "account-not-found", requested: wantedAccount, candidates: names },
      });
    }
    if (!scoped.some((i) => enabledFlags[i] === true)) {
      return JSON.stringify({
        ok: false,
        error: { code: "account-disabled", account: wantedAccount },
      });
    }
    scoped = scoped.filter((i) => enabledFlags[i] === true);
  } else {
    for (var i = 0; i < all.length; i++) if (enabledFlags[i] === true) scoped.push(i);
  }

  const results = [];
  const skipped = [];

  for (const idx of scoped) {
    const accountName = names[idx];
    const segs = wantedPath.split("/");
    let level = attempt(() => all[idx].mailboxes(), null);
    if (level === null) {
      skipped.push({ account: accountName, reason: "mailbox list unreadable" });
      continue;
    }

    let current = null;
    let failed = null;
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
        failed = {
          code: "mailbox-not-found",
          requested: wantedPath,
          account: accountName,
          candidates: available,
        };
        break;
      }
      if (matches.length > 1) {
        const collidingPath = prefix ? prefix + "/" + seg : seg;
        failed = {
          code: "mailbox-ambiguous",
          requested: wantedPath,
          account: accountName,
          candidates: matches.map(() => collidingPath),
        };
        break;
      }
      current = matches[0];
      prefix = prefix ? prefix + "/" + seg : seg;
      if (s < segs.length - 1) level = attempt(() => current.mailboxes(), []);
    }

    if (failed) {
      // An explicit account scope means the caller asked about this exact
      // account: refuse loudly. An unscoped scan reports it as skipped so
      // the other accounts still answer, and the total is labeled a floor.
      if (wantedAccount) return JSON.stringify({ ok: false, error: failed });
      skipped.push({ account: accountName, reason: failed.code + " for path " + wantedPath });
      continue;
    }

    const unread = attempt(() => current.unreadCount(), null);
    if (unread === null) {
      skipped.push({ account: accountName, reason: "unreadCount unreadable for " + prefix });
      continue;
    }
    results.push({ account: accountName, path: prefix, unreadCount: unread });
  }

  return JSON.stringify({ ok: true, results: results, skipped: skipped });
}
