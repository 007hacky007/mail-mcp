// Walks mailbox trees building full paths top-down, because a bare leaf name
// is not a usable identifier: real accounts here have the same name at two
// depths and even two same-named top-level siblings (03-object-model.md
// section 3). Counts are optional because they are the expensive part: each
// mailbox's messages.length is its own Apple Event and a full counted walk
// of this machine took 20-75s, versus a few seconds structure-only.
//
// argv: [accountName or "" for all accounts, includeCounts "true"/"false"]
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
  const wanted = args[0] || "";
  const includeCounts = args[1] !== "false";

  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const all = Mail.accounts();
  const names = all.map((a) => attempt(() => a.name(), "<unreadable>"));

  let scopedIdx = names.map((_, i) => i);
  if (wanted) {
    // Validate against the enumerated list BEFORE touching anything: Mail's
    // -1728 for a bad name names no object and cannot be recovered later.
    scopedIdx = scopedIdx.filter((i) => names[i] === wanted);
    if (scopedIdx.length === 0) {
      return JSON.stringify({
        ok: false,
        error: { code: "account-not-found", requested: wanted, candidates: names },
      });
    }
  }

  function walk(box, prefix, depth, out) {
    const name = attempt(() => box.name(), "<unreadable>");
    const path = prefix ? prefix + "/" + name : name;
    const entry = { name: name, path: path, depth: depth };
    if (includeCounts) {
      entry.messageCount = attempt(() => box.messages.length, -1);
      entry.unreadCount = attempt(() => box.unreadCount(), -1);
    }
    out.push(entry);
    const kids = attempt(() => box.mailboxes(), []);
    for (const kid of kids) walk(kid, path, depth + 1, out);
  }

  const accounts = scopedIdx.map(function (i) {
    const boxes = [];
    for (const b of attempt(() => all[i].mailboxes(), [])) walk(b, "", 0, boxes);
    return {
      name: names[i],
      enabled: attempt(() => all[i].enabled(), false),
      mailboxes: boxes,
    };
  });

  return JSON.stringify({ ok: true, accounts: accounts });
}
