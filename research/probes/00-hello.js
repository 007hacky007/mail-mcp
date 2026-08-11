// Smoke test: is Mail reachable, and does argv survive intact?
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

function run(argv) {
  const args = argsOf(argv);
  const Mail = Application("Mail");
  return JSON.stringify({
    mailReachable: true,
    accountCount: Mail.accounts.name().length,
    argvEcho: args,
  });
}
