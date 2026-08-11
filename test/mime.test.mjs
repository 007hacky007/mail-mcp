import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMime, findHtmlBody } from "../src/mail/mime.mjs";

// Pure fixtures, no Mail. The parser exists because Mail's attachment objects
// and upstream's source handling are both unreliable: upstream shipped the
// entire raw MIME blob mislabeled as the HTML body. These tests pin the
// behaviors that prevent exactly that.

const CRLF = "\r\n";

test("single-part text/html decodes base64 with utf-8 including emoji", () => {
  const html = "<p>ahoj \u{1F600}</p>";
  const source = [
    "From: a@example.com",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(html, "utf8").toString("base64"),
  ].join(CRLF);
  assert.equal(findHtmlBody(parseMime(source)), html);
});

test("multipart/alternative prefers the html part and decodes quoted-printable", () => {
  const source = [
    "MIME-Version: 1.0",
    'Content-Type: multipart/alternative; boundary="BND"',
    "",
    "preamble to ignore",
    "--BND",
    "Content-Type: text/plain; charset=us-ascii",
    "",
    "plain text",
    "--BND",
    "Content-Type: text/html; charset=iso-8859-1",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>caf=E9 3=3D3</p>",
    "--BND--",
    "epilogue",
  ].join(CRLF);
  assert.equal(findHtmlBody(parseMime(source)), "<p>café 3=3</p>");
});

test("nested multipart/mixed finds html inside alternative, never the attachment", () => {
  const source = [
    'Content-Type: multipart/mixed; boundary="OUT"',
    "",
    "--OUT",
    'Content-Type: multipart/alternative; boundary="IN"',
    "",
    "--IN",
    "Content-Type: text/plain",
    "",
    "plain",
    "--IN",
    "Content-Type: text/html; charset=utf-8",
    "",
    "<b>real body</b>",
    "--IN--",
    "--OUT",
    "Content-Type: application/pdf; name=doc.pdf",
    "Content-Disposition: attachment; filename=doc.pdf",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("%PDF-fake").toString("base64"),
    "--OUT--",
  ].join(CRLF);
  assert.equal(findHtmlBody(parseMime(source)), "<b>real body</b>");
});

test("a message with no html part yields null, not the raw source", () => {
  const source = ["Content-Type: text/plain", "", "just text"].join(CRLF);
  assert.equal(findHtmlBody(parseMime(source)), null);
});

test("an html part marked as attachment is not the body", () => {
  const source = [
    'Content-Type: multipart/mixed; boundary="B"',
    "",
    "--B",
    "Content-Type: text/plain",
    "",
    "body",
    "--B",
    "Content-Type: text/html",
    "Content-Disposition: attachment; filename=page.html",
    "",
    "<p>saved page</p>",
    "--B--",
  ].join(CRLF);
  assert.equal(findHtmlBody(parseMime(source)), null);
});

test("LF-only sources parse the same as CRLF", () => {
  const source = [
    'Content-Type: multipart/alternative; boundary="B"',
    "",
    "--B",
    "Content-Type: text/html",
    "",
    "<i>lf</i>",
    "--B--",
  ].join("\n");
  assert.equal(findHtmlBody(parseMime(source)), "<i>lf</i>");
});

test("folded headers unfold before parsing parameters", () => {
  const source = [
    "Content-Type: multipart/alternative;",
    '\tboundary="FOLDED"',
    "",
    "--FOLDED",
    "Content-Type: text/html",
    "",
    "<u>ok</u>",
    "--FOLDED--",
  ].join(CRLF);
  assert.equal(findHtmlBody(parseMime(source)), "<u>ok</u>");
});

test("an unknown charset falls back to utf-8 rather than throwing", () => {
  const source = [
    "Content-Type: text/html; charset=x-mystery-encoding",
    "",
    "<p>bytes</p>",
  ].join(CRLF);
  assert.equal(findHtmlBody(parseMime(source)), "<p>bytes</p>");
});
