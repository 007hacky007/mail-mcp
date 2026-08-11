// Creates a draft. `make new outgoing message` with visible:false, recipients
// as child objects, then save, which files it into Drafts. There is no send
// call anywhere in this tree: the user reviews and sends from Mail.app.
//
// Arrays arrive as JSON strings inside argv values; they are parsed, never
// interpolated into code. argv: [toJson, ccJson, bccJson, subject, body,
// attachmentPathsJson]
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

function run(argv) {
  const args = argsOf(argv);
  const to = JSON.parse(args[0]);
  const cc = JSON.parse(args[1]);
  const bcc = JSON.parse(args[2]);
  const subject = args[3];
  const body = args[4];
  const attachmentPaths = JSON.parse(args[5]);

  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const msg = Mail.OutgoingMessage({ subject: subject, content: body, visible: false });
  Mail.outgoingMessages.push(msg);
  for (const addr of to) msg.toRecipients.push(Mail.ToRecipient({ address: addr }));
  for (const addr of cc) msg.ccRecipients.push(Mail.CcRecipient({ address: addr }));
  for (const addr of bcc) msg.bccRecipients.push(Mail.BccRecipient({ address: addr }));

  let attachmentsAttached = 0;
  let attachmentError = "";
  for (const p of attachmentPaths) {
    // Attachments hang off the rich-text content in Mail's model. Two known
    // shapes exist across versions; try the direct element first.
    let done = attempt(() => {
      msg.attachments.push(Mail.Attachment({ fileName: Path(p) }));
      return true;
    }, false);
    if (!done) {
      done = attempt(() => {
        msg.content.attachments.push(Mail.Attachment({ fileName: Path(p) }));
        return true;
      }, false);
    }
    if (done) {
      attachmentsAttached++;
    } else {
      attachmentError = "could not attach: " + p;
      break;
    }
  }
  if (attachmentPaths.length > 0 && attachmentsAttached < attachmentPaths.length) {
    return JSON.stringify({
      ok: false,
      error: { code: "attachment-failed", detail: attachmentError },
    });
  }

  Mail.save(msg);

  const draft = {
    id: attempt(() => msg.id(), null),
    subject: attempt(() => msg.subject(), null),
    to: attempt(() => msg.toRecipients.address(), []),
    cc: attempt(() => msg.ccRecipients.address(), []),
    bcc: attempt(() => msg.bccRecipients.address(), []),
    contentLength: attempt(() => String(msg.content()).length, -1),
    attachmentCount: attachmentsAttached,
  };
  return JSON.stringify({ ok: true, draft: draft });
}
