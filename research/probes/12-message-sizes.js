// Bulk-fetches messageSize() for one mailbox and reduces it to a
// distribution, so a claim about how common large messages are can be
// measured directly instead of asserted from upstream's comments.
//
// The output shape is deliberately identical whether the account/mailbox
// lookup succeeds or fails (a fetchOk flag plus -1 sentinels, never a
// differently-shaped error object): research/verify.mjs replays a probe
// using the ARGS AS RECORDED, and record.mjs redacts account/mailbox names
// in `args` before writing them to disk (they are not standard mailbox
// names, so they do not survive redaction verbatim - see
// research/redact.mjs). A verify run therefore always calls this probe
// with placeholder strings, not the real account/mailbox names, and must
// still see the same shape a real, successful run produced.
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

function run(argv) {
  const [accountName, mailboxName] = argsOf(argv);
  const Mail = Application("Mail");

  let sizes = null;
  let fetchError = "";
  try {
    const box = Mail.accounts.byName(accountName).mailboxes.byName(mailboxName);
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
    messageCount: n,
    maxSizeBytes: max,
    medianSizeBytes: median,
    over1MB: countOver(1 * 1024 * 1024),
    over4MB: countOver(4 * 1024 * 1024),
    over16MB: countOver(16 * 1024 * 1024),
    over64MB: countOver(64 * 1024 * 1024),
  });
}
