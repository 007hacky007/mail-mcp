// Bulk-fetches messageSize() for one mailbox and reduces it to a
// distribution, so a claim about how common large messages are can be
// measured directly instead of asserted from upstream's comments.
//
// Fix round 1 (task-5-review, the CRITICAL finding): this probe takes an
// ACCOUNT SELECTOR, not a raw account name - see
// research/probes/04-message-props.js's header comment for the full
// explanation of why (that probe and this one shared the exact same
// defect: research/verify.mjs replays a probe's args VERBATIM, and a raw
// account name used to get silently redacted by research/record.mjs into a
// placeholder that resolves to nothing real, so every verify replay of
// this probe reached fetchOk: false while still reporting a shape match -
// a false pass).
//
// The output shape is still deliberately identical whether the account/
// mailbox lookup succeeds or fails (a fetchOk flag plus -1 sentinels, never
// a differently-shaped error object) - that part of the original design was
// already correct and is kept: a selector CAN legitimately fail to resolve
// (see resolveAccount()'s "gmail-style" case, which does not currently
// resolve on this machine - docs/apple-mail/03-object-model.md), and that
// failure deserves the same graceful, shape-stable handling as a bad
// mailbox name always did. What changed is that a NORMAL run, using the
// selector this file's own recording actually stores, now reaches fetchOk:
// true and real data on replay, instead of always hitting the failure
// branch regardless of input.
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

// Same resolver as research/probes/04-message-props.js, duplicated on
// purpose so every probe in this project stays standalone-runnable (see
// that file's header comment for the full explanation, and
// docs/apple-mail/01-execution-model.md section 1 for why this project
// prefers duplication over a shared import here).
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
  if (selector === "gmail-style") {
    for (const a of accounts) {
      let enabled = false;
      try { enabled = a.enabled(); } catch (e) { enabled = false; }
      if (!enabled) continue;
      try {
        a.mailboxes.byName("All Mail").name();
        return a;
      } catch (e) { /* not this one */ }
    }
    throw new Error('selector "gmail-style": no enabled account exposing an "All Mail" mailbox was found');
  }
  throw new Error(`unknown account selector "${selector}"`);
}

function run(argv) {
  const [accountSelector, mailboxName] = argsOf(argv);
  const Mail = Application("Mail");

  let sizes = null;
  let fetchError = "";
  let accountName = "";
  try {
    const account = resolveAccount(Mail, accountSelector);
    try { accountName = account.name(); } catch (e) { accountName = "<unreadable>"; }
    const box = account.mailboxes.byName(mailboxName);
    sizes = Array.prototype.slice.call(box.messages.messageSize());
  } catch (e) {
    fetchError = String(e);
  }

  const fetchOk = sizes !== null;
  const sorted = fetchOk ? sizes.sort(function (a, b) { return a - b; }) : [];
  const n = sorted.length;
  const max = n ? sorted[n - 1] : -1;
  const median = n === 0
    ? -1
    : n % 2 === 1
      ? sorted[(n - 1) / 2]
      : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const countOver = function (bytes) {
    return fetchOk ? sorted.filter(function (s) { return s > bytes; }).length : -1;
  };

  return JSON.stringify({
    fetchOk: fetchOk,
    fetchError: fetchError,
    accountName: accountName,
    messageCount: n,
    maxSizeBytes: max,
    medianSizeBytes: median,
    over1MB: countOver(1 * 1024 * 1024),
    over4MB: countOver(4 * 1024 * 1024),
    over16MB: countOver(16 * 1024 * 1024),
    over64MB: countOver(64 * 1024 * 1024),
  });
}
