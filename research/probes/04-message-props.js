// Reads every property of a single message, timed individually, so
// per-property cost and type are visible without a bulk fetch (which reads
// N messages at once) confusing the picture. Deliberately reads one message
// only - source() on the wrong message could be 25+ MB (see
// research/results/12-message-sizes.json); reading it here as a single
// sample, not bulk-fetched across a mailbox, is what keeps this probe cheap.
// `sample` is redacted by research/redact.mjs before anything is recorded:
// a subject or sender is personal data, so the committed recording only ever
// shows an opaque descriptor, never the real value.
//
// Fix round 1 (task-5-review, the CRITICAL finding): this probe takes an
// ACCOUNT SELECTOR, never a raw account name, as its first argument - see
// resolveAccount() below. research/record.mjs now only stores a probe
// argument verbatim when it is provably non-personal (a decimal index, a
// known selector keyword, or a standard mailbox name) and REFUSES to record
// anything else - it used to silently redact a raw account name into an
// opaque placeholder instead, which research/verify.mjs then replayed
// VERBATIM on every future run. `Mail.accounts.byName("<str len=5 chars=
// ascii>")` resolves to nothing real, but does not throw immediately (JXA
// specifiers resolve lazily); every subsequent `m.xxx()` call inside
// timed() then failed, and because timed()'s failure branch is (correctly,
// separately) shape-stable, the WHOLE probe's shape still matched its
// recording. `research/verify.mjs` reported 7/7 while never touching real
// Mail data for this probe on replay - a false pass, not a fix. The
// resolved account's real name is still reported, as `accountName` below,
// through the SAME "accountname" redaction rule this project already uses
// elsewhere - so the recording documents which account was actually
// measured without the selector argument itself ever being personal.
//
// timed()'s two branches are shape-identical on purpose - {ok, seconds,
// type, sample, error}, always all five keys, `sample` always a string.
// This is a SEPARATE, real fingerprint-noise trap (the original failure
// branch omitted `type`/`sample` entirely) and is kept regardless of the
// fix above, as defensive shape design for any property this probe cannot
// read for some other reason even with a resolvable selector.
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

// Resolves an account selector against the live account list - see the
// header comment above for why this exists instead of taking a raw account
// name. Supports exactly three forms:
//   - a decimal string: a zero-based index into Mail.accounts()
//   - "largest-enabled": the enabled account with the most messages in its INBOX
//   - "gmail-style": the enabled account exposing an "All Mail" mailbox
// Throws if the selector cannot be resolved, deliberately: a probe that
// cannot resolve its own selector should fail loudly (a whole-probe
// failure, visible to research/verify.mjs as "probe did not run"), not
// silently produce an unrelated per-property failure shape.
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

function timed(fn) {
  const t0 = $.NSDate.date;
  try {
    const value = fn();
    return {
      ok: true,
      seconds: $.NSDate.date.timeIntervalSinceDate(t0),
      type: Array.isArray(value) ? "array" : typeof value,
      sample: typeof value === "string" ? value.slice(0, 60) : String(value),
      error: "",
    };
  } catch (e) {
    return {
      ok: false,
      seconds: $.NSDate.date.timeIntervalSinceDate(t0),
      type: "unavailable",
      sample: "",
      error: String(e),
    };
  }
}

function run(argv) {
  const [accountSelector, mailboxName] = argsOf(argv);
  const Mail = Application("Mail");
  const account = resolveAccount(Mail, accountSelector);
  const box = account.mailboxes.byName(mailboxName);
  const m = box.messages[0];
  let accountName;
  try { accountName = account.name(); } catch (e) { accountName = "<unreadable>"; }
  return JSON.stringify({
    accountName: accountName,
    props: {
      id: timed(() => m.id()),
      messageId: timed(() => m.messageId()),
      subject: timed(() => m.subject()),
      sender: timed(() => m.sender()),
      dateReceived: timed(() => String(m.dateReceived())),
      dateSent: timed(() => String(m.dateSent())),
      readStatus: timed(() => m.readStatus()),
      flaggedStatus: timed(() => m.flaggedStatus()),
      flagIndex: timed(() => m.flagIndex()),
      messageSize: timed(() => m.messageSize()),
      mailboxName: timed(() => m.mailbox.name()),
      replyTo: timed(() => m.replyTo()),
      toRecipients: timed(() => m.toRecipients().length),
      ccRecipients: timed(() => m.ccRecipients().length),
      contentLength: timed(() => String(m.content()).length),
      sourceLength: timed(() => String(m.source()).length),
      attachmentCount: timed(() => m.mailAttachments().length),
    },
  });
}
