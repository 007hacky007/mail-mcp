// Walks every account's mailbox tree, building full paths as it descends,
// since mailboxes nest (a "[Gmail]" container is the common case) and a bare
// leaf name is not enough to tell two same-named mailboxes under different
// parents apart. attempt() here takes a fallback value rather than an
// {ok,error} wrapper (unlike 02-accounts.js) because the caller (walk) needs
// a plain value to keep building the path/tree with, not a branch to inspect.
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn, fallback) { try { return fn(); } catch { return fallback; } }

function walk(box, prefix, out, depth) {
  const name = attempt(() => box.name(), "<unreadable>");
  const path = prefix ? `${prefix}/${name}` : name;
  out.push({
    name,
    path,
    depth,
    messageCount: attempt(() => box.messages.length, -1),
    unreadCount: attempt(() => box.unreadCount(), -1),
  });
  const kids = attempt(() => box.mailboxes(), []);
  for (const kid of kids) walk(kid, path, out, depth + 1);
}

function run(argv) {
  const args = argsOf(argv);
  const Mail = Application("Mail");
  const wanted = args[0];
  const accounts = Mail.accounts().filter(
    (a) => !wanted || attempt(() => a.name(), "") === wanted
  );
  return JSON.stringify({
    accounts: accounts.map((a) => {
      const boxes = [];
      for (const b of attempt(() => a.mailboxes(), [])) walk(b, "", boxes, 0);
      return { name: attempt(() => a.name(), "<unreadable>"), mailboxes: boxes };
    }),
  });
}
