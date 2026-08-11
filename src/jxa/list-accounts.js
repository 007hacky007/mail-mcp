// Enumerates every configured account. Disabled accounts are included and
// flagged, never omitted: their own properties always read fine (verified,
// docs/apple-mail/03-object-model.md section 2), the only signals are
// enabled=false and mailboxCount=0, and treating them as unreadable was a
// real upstream bug (#143).
//
// In file mode osascript passes the `--` separator through in argv; every
// script strips it the same way, inline, so each stays runnable standalone.
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

  const accounts = Mail.accounts().map(function (a) {
    return {
      name: attempt(() => a.name(), "<unreadable>"),
      enabled: attempt(() => a.enabled(), false),
      // The raw value is an enum, not a plain string; String() coerces it.
      accountType: String(attempt(() => a.accountType(), "unknown")),
      emailAddresses: attempt(() => a.emailAddresses(), []),
      mailboxCount: attempt(() => a.mailboxes().length, -1),
    };
  });

  return JSON.stringify({ accounts: accounts });
}
