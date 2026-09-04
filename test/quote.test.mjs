import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cleanBodyText,
  formatQuoteDate,
  formatAddress,
  escapeHtml,
  textToHtml,
  buildReplyQuoteHtml,
  buildForwardBlockHtml,
} from "../src/mail/quote.mjs";

// Mail's `content` for an HTML message is the plain-text rendering: object
// replacement characters where images were, trailing spaces on every line,
// and runs of blank lines. The quote must not carry that noise.

const PRAGUE = { timeZone: "Europe/Prague" };

test("cleanBodyText strips image placeholders and trailing whitespace", () => {
  const raw = "\n￼ \nHi Jan! \nLine two. \n\n￼\nBye\n\n\n";
  assert.equal(cleanBodyText(raw), "Hi Jan!\nLine two.\n\nBye");
});

test("cleanBodyText normalizes CRLF and tolerates non-strings", () => {
  assert.equal(cleanBodyText("a\r\nb\r\n"), "a\nb");
  assert.equal(cleanBodyText(null), "");
  assert.equal(cleanBodyText(undefined), "");
});

test("formatQuoteDate renders an unambiguous long date in the given zone", () => {
  assert.equal(formatQuoteDate("2026-09-02T23:00:00.000Z", PRAGUE), "3 September 2026 at 01:00");
  assert.equal(formatQuoteDate("2026-09-02T23:00:00.000Z", { timeZone: "UTC" }), "2 September 2026 at 23:00");
});

test("formatQuoteDate returns null for missing or unparseable dates", () => {
  assert.equal(formatQuoteDate(null), null);
  assert.equal(formatQuoteDate("not a date"), null);
});

test("formatAddress prefers name <address>, falls back to whichever exists", () => {
  assert.equal(formatAddress({ name: "Ann", address: "ann@x.com" }), "Ann <ann@x.com>");
  assert.equal(formatAddress({ name: null, address: "ann@x.com" }), "ann@x.com");
  assert.equal(formatAddress({ name: "ann@x.com", address: "ann@x.com" }), "ann@x.com");
  assert.equal(formatAddress({ name: "Ann", address: null }), "Ann");
});

// Everything that reaches the draft's HTML is escaped: the body (so a model
// cannot smuggle markup or links into the user's outgoing mail) and the
// original (attacker-controlled input by definition).
test("escapeHtml neutralizes markup-significant characters", () => {
  assert.equal(escapeHtml(`<b a="x">&'`), "&lt;b a=&quot;x&quot;&gt;&amp;&#39;");
  assert.equal(escapeHtml(null), "");
});

test("textToHtml turns lines into divs the way Mail's editor does", () => {
  assert.equal(textToHtml("one\ntwo"), "<div>one</div><div>two</div>");
  assert.equal(textToHtml("one\n\ntwo"), "<div>one</div><div><br></div><div>two</div>");
  assert.equal(textToHtml("a <b>\r\nc"), "<div>a &lt;b&gt;</div><div>c</div>");
  assert.equal(textToHtml(""), "");
});

test("textToHtml rebuilds '>' quote levels as nested cite blockquotes", () => {
  assert.equal(
    textToHtml("reply\n> older\n> > oldest\n> older again\nend"),
    "<div>reply</div>" +
      '<blockquote type="cite"><div>older</div>' +
      '<blockquote type="cite"><div>oldest</div></blockquote>' +
      "<div>older again</div></blockquote>" +
      "<div>end</div>"
  );
  assert.equal(textToHtml(">> tight\n>"), '<blockquote type="cite"><blockquote type="cite"><div>tight</div></blockquote><div><br></div></blockquote>');
});

test("buildReplyQuoteHtml is a cite blockquote holding Mail-style attribution and the original", () => {
  const html = buildReplyQuoteHtml(
    { sender: "Example GitLab <gitlab@example.invalid>", dateSent: "2026-09-02T23:00:00.000Z", textBody: "Hi\n\nBye" },
    PRAGUE
  );
  assert.equal(
    html,
    '<blockquote type="cite">' +
      "<div>On 3 September 2026 at 01:00, Example GitLab &lt;gitlab@example.invalid&gt; wrote:</div><br>" +
      "<div>Hi</div><div><br></div><div>Bye</div>" +
      "</blockquote>"
  );
});

test("buildReplyQuoteHtml nests the original's own '>' quotes and cleans its noise", () => {
  const html = buildReplyQuoteHtml({ sender: "Ann <ann@x.com>", dateSent: null, textBody: "￼ \nnew \n> old" }, PRAGUE);
  assert.equal(
    html,
    '<blockquote type="cite"><div>Ann &lt;ann@x.com&gt; wrote:</div><br>' +
      '<div>new</div><blockquote type="cite"><div>old</div></blockquote></blockquote>'
  );
});

test("buildReplyQuoteHtml falls back to dateReceived and to an anonymous sender", () => {
  const html = buildReplyQuoteHtml(
    { sender: null, dateSent: null, dateReceived: "2026-09-02T23:00:00.000Z", textBody: "x" },
    PRAGUE
  );
  assert.match(html, /^<blockquote type="cite"><div>On 3 September 2026 at 01:00, the original sender wrote:<\/div>/);
});

test("buildReplyQuoteHtml truncates enormous originals and says so inside the quote", () => {
  const html = buildReplyQuoteHtml({ sender: "Ann <ann@x.com>", dateSent: null, textBody: "abcdefghij" }, { ...PRAGUE, maxChars: 4 });
  assert.match(html, /<div>abcd<\/div><div>\[quoted text truncated\]<\/div><\/blockquote>$/);
});

test("buildForwardBlockHtml reproduces Mail's forwarded-message block", () => {
  const html = buildForwardBlockHtml(
    {
      sender: "Example GitLab <gitlab@example.invalid>",
      subject: "Your tokens",
      dateSent: "2026-09-02T23:00:00.000Z",
      to: [{ name: "Bea", address: "bea@x.com" }, { name: null, address: "b@x.com" }],
      replyTo: null,
      textBody: "￼ \nHi\nBye \n",
    },
    PRAGUE
  );
  assert.equal(
    html,
    '<blockquote type="cite"><div>Begin forwarded message:</div><br>' +
      "<div><b>From: </b>Example GitLab &lt;gitlab@example.invalid&gt;</div>" +
      "<div><b>Subject: </b>Your tokens</div>" +
      "<div><b>Date: </b>3 September 2026 at 01:00</div>" +
      "<div><b>To: </b>Bea &lt;bea@x.com&gt;, b@x.com</div>" +
      "<br><div>Hi</div><div>Bye</div></blockquote>"
  );
});

test("buildForwardBlockHtml includes Reply-To only when it differs from the sender", () => {
  const base = { sender: "Ann <ann@x.com>", subject: "s", dateSent: null, to: [], textBody: "x" };
  assert.match(buildForwardBlockHtml({ ...base, replyTo: "list@x.com" }, PRAGUE), /<div><b>Reply-To: <\/b>list@x.com<\/div>/);
  assert.doesNotMatch(buildForwardBlockHtml({ ...base, replyTo: "Ann <ann@x.com>" }, PRAGUE), /Reply-To/);
  assert.doesNotMatch(buildForwardBlockHtml(base, PRAGUE), /<b>To: /);
});
