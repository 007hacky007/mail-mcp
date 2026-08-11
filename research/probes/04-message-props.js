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
// timed()'s two branches are shape-identical on purpose - {ok, seconds, type,
// sample, error}, always all five keys, `sample` always a string - which is a
// deliberate change from this probe's first draft (matching the brief's
// verbatim sketch), where the failure branch omitted `type`/`sample`
// entirely and `sample` kept the property's native JS type (number/boolean)
// on success. That asymmetry is exactly the fingerprint-noise trap this
// project already knows to watch for (see research/probes/12-message-sizes.js's
// header comment): research/verify.mjs replays a probe using the args AS
// RECORDED, and record.mjs redacts account/mailbox names in args before
// writing them to disk, so a verify run always calls this probe with
// placeholder strings, not the real account/mailbox name. `Mail.accounts.byName`
// on a placeholder does not throw immediately (see the object-model doc), but
// every subsequent `m.xxx()` call inside a `timed()` wrapper does, so a
// verify replay flips EVERY property in this probe from the success shape to
// the failure shape at once. With the original two-shape design that made
// every single property report a spurious mismatch, 100% reproducibly, on
// every verify run - not a rare edge case. Reduced here to one shape so
// verify.mjs is comparing "did Mail's object model change" against a fixed
// point, not "did this call happen to succeed this time."
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }

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
  const [accountName, mailboxName] = argsOf(argv);
  const Mail = Application("Mail");
  const box = Mail.accounts.byName(accountName).mailboxes.byName(mailboxName);
  const m = box.messages[0];
  return JSON.stringify({
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
