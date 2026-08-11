// Cheapest possible round trip into Mail.app, plus the facts `doctor` reports.
// Used as the startup warm-up: the first Apple Event of Mail's process lifetime
// is dramatically slower than later ones, so this pays that cost up front.
//
// In file mode osascript passes the `--` separator through in argv, unlike -e
// mode. Every script strips it the same way, inline, so each script stays
// runnable standalone from a terminal.
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
  argsOf(argv);
  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  // `accounts.name()` is one Apple Event and is the cheapest useful liveness
  // check. If Automation permission is missing, this is what raises.
  const names = attempt(() => Mail.accounts.name(), null);

  if (names === null) {
    return JSON.stringify({
      mailReachable: false,
      accountCount: 0,
      enabledAccountCount: 0,
    });
  }

  var enabled = 0;
  for (var i = 0; i < names.length; i++) {
    if (attempt(() => Mail.accounts[i].enabled(), false) === true) enabled++;
  }

  return JSON.stringify({
    mailReachable: true,
    accountCount: names.length,
    enabledAccountCount: enabled,
  });
}
