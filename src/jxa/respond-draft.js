// Reply or forward draft, saved to Drafts and never sent. One script for both
// because they share everything that is delicate here: the `without opening
// window` requirement, the hidden `html content` property, and the two-pass
// signature dance. Read docs/apple-mail/README.md (draft recipes) first.
//
// argv: [mode "reply"|"forward", accountName, mailboxPath, id, toJson,
//        bodyHtml, quoteHtml, replyAll "true"/"false", signaturesJson]
//
// bodyHtml and quoteHtml are built and escaped in Node. Both empty means
// "forward without a note": content is left alone and Mail builds the forward
// itself. signaturesJson is {signature name: signature HTML}, the server's
// in-memory cache of signatures harvested by earlier calls.
//
// Why two passes. Setting content (through `content` or `html content`)
// replaces Mail's whole reply template, quote included, and Mail then appends
// the account signature AFTER whatever was set - below the quote, where no
// native reply puts it. The scripting bridge exposes the signature only as
// plain text. But the draft Mail saves in pass 1 carries the signature's real
// HTML, so: save once, read that draft's source back, cut the signature block
// out, set `message signature` to missing value (or Mail appends a second
// copy), and save again with body + signature + quote in Mail's own order.
// The second save replaces the draft; it does not duplicate it (measured
// 2026-09-04). Mail removes any element whose id is AppleMailSignature when
// the signature is missing value, so the harvested block is re-embedded with
// every such id stripped.
//
// The pure helpers below (decodeQuotedPrintable, htmlPartOf,
// extractSignatureBlock, composeHtml, markerComment) are unit-tested from
// Node in test/jxa-helpers.test.mjs; this file must stay loadable in a bare
// JS context, so nothing may run at top level.
function argsOf(argv) { return argv[0] === "--" ? argv.slice(1) : argv; }
function attempt(fn, fallback) { try { return fn(); } catch (e) { return fallback; } }

function resolveAccount(Mail, wanted) {
  const all = Mail.accounts();
  const names = all.map((a) => attempt(() => a.name(), "<unreadable>"));
  const matched = [];
  for (var i = 0; i < all.length; i++) if (names[i] === wanted) matched.push(i);
  if (matched.length === 0) {
    return { error: { code: "account-not-found", requested: wanted, candidates: names } };
  }
  const enabledIdx = matched.filter((i) => attempt(() => all[i].enabled(), false) === true);
  if (enabledIdx.length === 0) return { error: { code: "account-disabled", account: wanted } };
  return { account: all[enabledIdx[0]], name: names[enabledIdx[0]] };
}

function resolveMailbox(account, accountName, wantedPath) {
  const segs = wantedPath.split("/");
  let level = attempt(() => account.mailboxes(), null);
  if (level === null) {
    return { error: { code: "mailbox-not-found", requested: wantedPath, account: accountName, candidates: [] } };
  }
  let current = null;
  let prefix = "";
  for (var s = 0; s < segs.length; s++) {
    const seg = segs[s];
    const matches = [];
    for (var b = 0; b < level.length; b++) {
      if (attempt(() => level[b].name(), null) === seg) matches.push(level[b]);
    }
    if (matches.length === 0) {
      const available = level
        .map((x) => attempt(() => x.name(), "<unreadable>"))
        .map((n) => (prefix ? prefix + "/" + n : n));
      return { error: { code: "mailbox-not-found", requested: wantedPath, account: accountName, candidates: available } };
    }
    if (matches.length > 1) {
      const collidingPath = prefix ? prefix + "/" + seg : seg;
      return { error: { code: "mailbox-ambiguous", requested: wantedPath, account: accountName, candidates: matches.map(() => collidingPath) } };
    }
    current = matches[0];
    prefix = prefix ? prefix + "/" + seg : seg;
    if (s < segs.length - 1) level = attempt(() => current.mailboxes(), []);
  }
  return { box: current, path: prefix };
}

// ---- pure helpers ---------------------------------------------------------

// Quoted-printable to text, UTF-8 aware: "=XX" runs become percent escapes
// and everything else is percent-encoded too, so one decodeURIComponent
// reassembles multibyte sequences. Falls back to the joined text on malformed
// input rather than throwing inside Mail.
function decodeQuotedPrintable(text) {
  const joined = String(text).replace(/=\r?\n/g, "");
  try {
    let pct = "";
    for (var i = 0; i < joined.length; i++) {
      const ch = joined[i];
      if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(joined.substr(i + 1, 2))) {
        pct += "%" + joined.substr(i + 1, 2);
        i += 2;
      } else {
        pct += encodeURIComponent(ch);
      }
    }
    return decodeURIComponent(pct);
  } catch (e) {
    return joined;
  }
}

// The decoded text/html part of a multipart MIME source, or null when there
// is none (or it uses an encoding this does not handle, such as base64).
function htmlPartOf(source) {
  const text = String(source);
  const top = /^Content-Type:\s*multipart\/[^;]+;\s*(?:\r?\n[ \t]+)?boundary="?([^"\r\n;]+)"?/im.exec(text);
  if (!top) return null;
  const parts = text.split("--" + top[1]);
  for (var p = 0; p < parts.length; p++) {
    const part = parts[p];
    const headerEnd = part.search(/\r?\n\r?\n/);
    if (headerEnd < 0) continue;
    const headers = part.slice(0, headerEnd);
    if (!/^Content-Type:\s*text\/html/im.test(headers)) continue;
    const body = part.slice(headerEnd).replace(/^\r?\n\r?\n/, "");
    const encMatch = /^Content-Transfer-Encoding:\s*([^\r\n]+)/im.exec(headers);
    const enc = (encMatch ? encMatch[1] : "7bit").trim().toLowerCase();
    if (enc === "quoted-printable") return decodeQuotedPrintable(body);
    if (enc === "7bit" || enc === "8bit" || enc === "binary") return body;
    return null;
  }
  return null;
}

// The balanced <div id="AppleMailSignature">...</div> block, with every
// AppleMailSignature id removed (Mail nests several and deletes them all
// when the message signature is missing value). Null when absent or
// unbalanced.
function extractSignatureBlock(html) {
  const text = String(html);
  const start = text.indexOf('<div id="AppleMailSignature"');
  if (start < 0) return null;
  const re = /<div\b[^>]*>|<\/div>/gi;
  re.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (m[0].charAt(1) === "/") {
      depth--;
      if (depth === 0) {
        return text.slice(start, m.index + m[0].length).replace(/ id="AppleMailSignature"/g, "");
      }
    } else {
      depth++;
    }
  }
  return null;
}

function composeHtml(bodyHtml, signatureHtml, quoteHtml) {
  const parts = [];
  if (bodyHtml) parts.push(bodyHtml);
  if (signatureHtml) parts.push(signatureHtml);
  if (quoteHtml) parts.push(quoteHtml);
  return parts.join("<br>");
}

function markerComment(token) { return "<!--mail-mcp:" + token + "-->"; }

// ---- Mail-facing ----------------------------------------------------------

// The draft just saved, found in the application-level Drafts mailbox by
// exact subject and by the marker comment inside its decoded HTML (the raw
// source is quoted-printable and may split the marker across lines). Returns
// the decoded HTML or null.
function locateSavedDraftHtml(Mail, subject, token, maxWaitMs) {
  const marker = markerComment(token);
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const msgs = attempt(() => Mail.draftsMailbox().messages, null);
    const subjects = msgs ? attempt(() => msgs.subject(), []) : [];
    for (var i = 0; i < subjects.length; i++) {
      if (String(subjects[i]) !== subject) continue;
      const html = htmlPartOf(String(attempt(() => msgs[i].source(), "")));
      if (html !== null && html.indexOf(marker) !== -1) return html;
    }
    delay(0.3);
  }
  return null;
}

function run(argv) {
  const args = argsOf(argv);
  const mode = args[0];
  const wantedAccount = args[1];
  const wantedPath = args[2];
  const idNum = Number(args[3]);
  const to = JSON.parse(args[4]);
  const bodyHtml = args[5];
  const quoteHtml = args[6];
  const replyAll = args[7] === "true";
  const signatures = JSON.parse(args[8]);

  const Mail = Application("Mail");
  Mail.includeStandardAdditions = false;

  const acct = resolveAccount(Mail, wantedAccount);
  if (acct.error) return JSON.stringify({ ok: false, error: acct.error });
  const mb = resolveMailbox(acct.account, acct.name, wantedPath);
  if (mb.error) return JSON.stringify({ ok: false, error: mb.error });

  const m = mb.box.messages.byId(idNum);
  const realId = attempt(() => m.id(), null);
  if (realId === null) {
    return JSON.stringify({
      ok: false,
      error: { code: "message-not-found", requested: idNum, account: acct.name, mailbox: mb.path },
    });
  }

  const out =
    mode === "forward"
      ? Mail.forward(m, { openingWindow: false })
      : Mail.reply(m, { openingWindow: false, replyToAll: replyAll });
  if (mode === "forward") {
    for (const addr of to) out.toRecipients.push(Mail.ToRecipient({ address: addr }));
  }

  // Everything except id is read BEFORE the first save: post-save reads
  // through this object are unreliable (content comes back empty).
  const fields = {
    subject: attempt(() => out.subject(), null),
    to: attempt(() => out.toRecipients.address(), []),
    cc: attempt(() => out.ccRecipients.address(), []),
    bcc: attempt(() => out.bccRecipients.address(), []),
  };
  const done = (contentLength, signature, warning) => {
    const draft = {
      id: attempt(() => out.id(), null),
      subject: fields.subject,
      to: fields.to,
      cc: fields.cc,
      bcc: fields.bcc,
      contentLength: contentLength,
    };
    const result = { ok: true, draft: draft, signature: signature };
    if (warning) result.warning = warning;
    return JSON.stringify(result);
  };
  const notApplied = () =>
    JSON.stringify({
      ok: false,
      error: { code: "draft-body-not-applied", requested: idNum, account: acct.name, mailbox: mb.path },
    });

  if (!bodyHtml && !quoteHtml) {
    // Forward without a note: Mail's own forwarded block and signature placement.
    Mail.save(out);
    return done(-1, { name: null, placement: "mail-default", harvested: false });
  }

  const sig = attempt(() => out.messageSignature(), null);
  const sigName = sig ? attempt(() => String(sig.name()), null) : null;
  let signatureHtml = sigName && typeof signatures[sigName] === "string" && signatures[sigName] ? signatures[sigName] : null;
  let harvested = false;
  let warning = null;
  let firstPassLength = 0;

  if (sigName && signatureHtml === null) {
    // Pass 1: save with Mail's signature so its HTML can be read back.
    const token = String(Date.now()) + "-" + Math.floor(Math.random() * 1e9).toString(36);
    out.htmlContent = markerComment(token) + composeHtml(bodyHtml, null, quoteHtml);
    firstPassLength = String(attempt(() => out.content(), "")).length;
    if (firstPassLength === 0) return notApplied();
    Mail.save(out);
    const html = fields.subject === null ? null : locateSavedDraftHtml(Mail, String(fields.subject), token, 10000);
    if (html === null) {
      warning = "The saved draft could not be located to read the signature back, so the signature stays where Mail put it, below the quote.";
    } else {
      const block = extractSignatureBlock(html);
      if (block === null) {
        warning = "The saved draft carries no signature block to move, so the signature stays where Mail put it, below the quote.";
      } else if (/cid:/i.test(block)) {
        warning = "The signature embeds inline images, which cannot be re-embedded from a script, so it stays where Mail put it, below the quote.";
      } else {
        signatureHtml = block;
        harvested = true;
      }
    }
    if (signatureHtml === null) {
      return done(firstPassLength, { name: sigName, placement: "below-quote", harvested: false }, warning);
    }
  }

  if (signatureHtml === null) {
    // No signature configured for this account: a single pass, nothing to move.
    out.htmlContent = composeHtml(bodyHtml, null, quoteHtml);
    const readBack = String(attempt(() => out.content(), ""));
    if (readBack.length === 0) return notApplied();
    Mail.save(out);
    return done(readBack.length, { name: sigName, placement: "none", harvested: false });
  }

  // Final pass: suppress Mail's signature and place the real one above the quote.
  attempt(() => { out.messageSignature = null; return true; }, false);
  out.htmlContent = composeHtml(bodyHtml, signatureHtml, quoteHtml);
  const readBack = String(attempt(() => out.content(), ""));
  if (readBack.length === 0) {
    if (firstPassLength > 0) {
      return done(
        firstPassLength,
        { name: sigName, placement: "below-quote", harvested: false },
        "The second pass did not apply, so the first-pass draft stands with the signature below the quote."
      );
    }
    return notApplied();
  }
  Mail.save(out);
  const signature = { name: sigName, placement: "above-quote", harvested: harvested };
  if (harvested) signature.html = signatureHtml;
  return done(readBack.length, signature, warning);
}
