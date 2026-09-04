import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

// The respond-draft script carries pure parsing helpers (MIME part
// extraction, quoted-printable decoding, signature block extraction) that
// must be right or the draft silently loses its signature. JXA scripts are
// plain JavaScript that only define functions at top level, so they can be
// loaded into a bare context here and the helpers exercised without Mail.
const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = readFileSync(resolve(HERE, "..", "src", "jxa", "respond-draft.js"), "utf8");

function helpers() {
  const ctx = vm.createContext({});
  vm.runInContext(
    SCRIPT + "\n;this.__h = { decodeQuotedPrintable, htmlPartOf, extractSignatureBlock, composeHtml, markerComment };",
    ctx
  );
  return ctx.__h;
}

test("script defines only functions at top level (no work at load time)", () => {
  assert.doesNotThrow(() => helpers());
});

test("decodeQuotedPrintable joins soft breaks, decodes =XX and UTF-8 sequences", () => {
  const { decodeQuotedPrintable } = helpers();
  assert.equal(decodeQuotedPrintable("a=3Db=\r\nc"), "a=bc");
  assert.equal(decodeQuotedPrintable("=C4=8D=C5=A1=C5=BE 100=25"), "čšž 100%");
  assert.equal(decodeQuotedPrintable("plain text\nkept"), "plain text\nkept");
});

const SOURCE =
  "Subject: Re: x\r\n" +
  "Content-Type: multipart/alternative;\r\n\tboundary=\"Apple-Mail=_ABC\"\r\n" +
  "Mime-Version: 1.0\r\n\r\n\r\n" +
  "--Apple-Mail=_ABC\r\nContent-Transfer-Encoding: 7bit\r\nContent-Type: text/plain;\r\n\tcharset=us-ascii\r\n\r\n\r\n" +
  "--Apple-Mail=_ABC\r\nContent-Transfer-Encoding: quoted-printable\r\nContent-Type: text/html;\r\n\tcharset=utf-8\r\n\r\n" +
  "<html><body><div>body</div><div id=3D\"AppleMailSignature\"><div id=3D\"AppleMailSignat=\r\nure\">Best Regards,<br>=C4=8D</div><b>tail</b></div></body></html>\r\n" +
  "--Apple-Mail=_ABC--\r\n";

test("htmlPartOf finds the text/html part of a multipart source and decodes it", () => {
  const { htmlPartOf } = helpers();
  const html = htmlPartOf(SOURCE);
  assert.ok(html.startsWith("<html><body><div>body</div>"), html);
  assert.ok(html.includes('<div id="AppleMailSignature"><div id="AppleMailSignature">Best Regards,<br>č</div>'), html);
});

test("htmlPartOf returns null when there is no multipart boundary or no html part", () => {
  const { htmlPartOf } = helpers();
  assert.equal(htmlPartOf("Subject: x\r\nContent-Type: text/plain\r\n\r\nhello"), null);
  assert.equal(htmlPartOf(SOURCE.replace(/text\/html/g, "text/enriched")), null);
});

test("extractSignatureBlock returns the balanced signature div with every AppleMailSignature id removed", () => {
  const { extractSignatureBlock } = helpers();
  const html =
    '<div>body</div><br><div id="AppleMailSignature">\n<meta charset="UTF-8"><div dir="auto"><div id="AppleMailSignature">Best,<br></div>' +
    '<div id="AppleMailSignature"><a href="http://x">x</a></div></div><b>tail</b><br style="x"></div><br><blockquote type="cite">q</blockquote>';
  assert.equal(
    extractSignatureBlock(html),
    '<div>\n<meta charset="UTF-8"><div dir="auto"><div>Best,<br></div><div><a href="http://x">x</a></div></div><b>tail</b><br style="x"></div>'
  );
});

test("extractSignatureBlock returns null without a signature or with an unbalanced one", () => {
  const { extractSignatureBlock } = helpers();
  assert.equal(extractSignatureBlock("<div>no signature here</div>"), null);
  assert.equal(extractSignatureBlock('<div id="AppleMailSignature"><div>never closed'), null);
});

test("composeHtml joins body, signature and quote with line breaks, skipping empty parts", () => {
  const { composeHtml } = helpers();
  assert.equal(composeHtml("<div>b</div>", "<div>s</div>", "<blockquote>q</blockquote>"), "<div>b</div><br><div>s</div><br><blockquote>q</blockquote>");
  assert.equal(composeHtml("<div>b</div>", null, "<blockquote>q</blockquote>"), "<div>b</div><br><blockquote>q</blockquote>");
  assert.equal(composeHtml("<div>b</div>", null, ""), "<div>b</div>");
});

test("markerComment is an HTML comment that carries the token verbatim", () => {
  const { markerComment } = helpers();
  assert.equal(markerComment("abc-123"), "<!--mail-mcp:abc-123-->");
});
