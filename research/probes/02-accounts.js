// Reads every account property this project cares about, for every account
// Mail.app knows about - including disabled ones. Every read is wrapped in
// attempt() because a disabled account raises on some properties (not all),
// and one unwrapped throw would lose the whole result instead of recording
// exactly which properties survive and which don't.
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn) { try { return { ok: true, value: fn() }; } catch (e) { return { ok: false, error: String(e) }; } }

function run() {
  const Mail = Application("Mail");
  const accounts = Mail.accounts();
  return JSON.stringify({
    accountCount: accounts.length,
    accounts: accounts.map((a) => ({
      name: attempt(() => a.name()),
      enabled: attempt(() => a.enabled()),
      accountType: attempt(() => String(a.accountType())),
      emailAddresses: attempt(() => a.emailAddresses()),
      userName: attempt(() => a.userName()),
      serverName: attempt(() => a.serverName()),
      mailboxCount: attempt(() => a.mailboxes().length),
    })),
  });
}
