// Doctor probe. Reports whether Mail.app is running and reachable without
// launching it: Application("Mail").running() consults the process table and
// sends no Apple Event, whereas any property read (accounts.name()) would
// auto-launch Mail as a side effect, which a diagnostics tool must not do.
//
// In file mode osascript passes the `--` separator through in argv, unlike -e
// mode. Every script strips it the same way, inline, so each script stays
// runnable standalone from a terminal.
function argsOf(argv) {
  return argv[0] === "--" ? argv.slice(1) : argv;
}

function run(argv) {
  argsOf(argv);
  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const out = {
    mailRunning: false,
    mailReachable: false,
    accountCount: 0,
    enabledAccountCount: 0,
    errorText: "",
  };

  try {
    out.mailRunning = Mail.running();
  } catch (e) {
    out.errorText = String(e);
    return JSON.stringify(out);
  }
  if (!out.mailRunning) return JSON.stringify(out);

  // One Apple Event. If Automation permission is missing this raises -1743,
  // which is caught and reported as text so the server can classify it.
  try {
    const names = Mail.accounts.name();
    out.mailReachable = true;
    out.accountCount = names.length;
    var enabled = 0;
    for (var i = 0; i < names.length; i++) {
      try {
        if (Mail.accounts[i].enabled() === true) enabled++;
      } catch (e) {
        // A single unreadable account must not take the whole probe down.
      }
    }
    out.enabledAccountCount = enabled;
  } catch (e) {
    out.errorText = String(e);
  }
  return JSON.stringify(out);
}
