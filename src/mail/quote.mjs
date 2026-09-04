/**
 * Quoting for reply and forward drafts, as the HTML Mail.app itself writes.
 *
 * Mail's scripting bridge drops its own reply quote (and the whole forwarded
 * message) the moment `content` is set on the outgoing message, and there is
 * no way to insert text without replacing the template (measured 2026-09-04,
 * docs/apple-mail/README.md). The `html content` property, which the
 * dictionary marks hidden and "does nothing", in fact inserts raw HTML. So
 * the server builds body + quote as HTML in Mail's own shape: lines as
 * <div>s, the quoted original inside <blockquote type="cite"> with the
 * attribution line as its first child, which Mail renders with its vertical
 * quote bar.
 *
 * Nothing here passes through unescaped: the body comes from a model and the
 * original comes from whoever sent the mail, and neither gets to put markup
 * into the user's outgoing message.
 */

/** Mail renders inline images as U+FFFC in a message's plain-text content. */
const OBJECT_REPLACEMENT_CHAR = /￼/g;

/**
 * Cap on quoted characters. The composed HTML travels to osascript as one
 * argv value, and macOS caps argv plus environment at 1 MB total, so a
 * pathological body must not be allowed to fail the whole draft.
 */
export const MAX_QUOTED_CHARS = 200_000;

const TRUNCATION_NOTICE = "[quoted text truncated]";

export function cleanBodyText(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/\r\n?/g, "\n")
    .replace(OBJECT_REPLACEMENT_CHAR, "")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+/, "")
    .replace(/\n+$/, "");
}

/**
 * "3 September 2026 at 01:00": long month name, no locale-ambiguous
 * numeric order, 24-hour clock. Mail's own attribution uses the system
 * locale; this is deliberately fixed so tests and drafts agree.
 */
export function formatQuoteDate(value, { timeZone } = {}) {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "long", timeStyle: "short", timeZone }).format(date);
}

export function formatAddress({ name, address }) {
  const n = typeof name === "string" ? name.trim() : "";
  const a = typeof address === "string" ? address.trim() : "";
  if (n && a && n !== a) return `${n} <${a}>`;
  return a || n;
}

export function escapeHtml(text) {
  if (typeof text !== "string") return "";
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

const CITE_OPEN = '<blockquote type="cite">';
const CITE_CLOSE = "</blockquote>";

/**
 * Plain text to Mail-editor HTML: one <div> per line, <div><br></div> for a
 * blank line, and leading ">" markers rebuilt as nested cite blockquotes so
 * quoted history keeps its levels instead of showing literal ">" characters.
 */
export function textToHtml(text) {
  if (typeof text !== "string" || text === "") return "";
  const out = [];
  let depth = 0;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const marker = /^(?:>\s?)+/.exec(raw);
    const level = marker ? (marker[0].match(/>/g) || []).length : 0;
    const rest = marker ? raw.slice(marker[0].length) : raw;
    while (depth < level) {
      out.push(CITE_OPEN);
      depth++;
    }
    while (depth > level) {
      out.push(CITE_CLOSE);
      depth--;
    }
    out.push(rest === "" ? "<div><br></div>" : `<div>${escapeHtml(rest)}</div>`);
  }
  while (depth > 0) {
    out.push(CITE_CLOSE);
    depth--;
  }
  return out.join("");
}

function quotedOriginalHtml(textBody, maxChars) {
  const cleaned = cleanBodyText(textBody);
  const truncated = cleaned.length > maxChars;
  const html = textToHtml(truncated ? cleaned.slice(0, maxChars) : cleaned);
  return truncated ? `${html}<div>${TRUNCATION_NOTICE}</div>` : html;
}

function whenAndWho(message, opts) {
  const when = formatQuoteDate(message.dateSent ?? message.dateReceived ?? null, opts);
  const who = typeof message.sender === "string" && message.sender.trim() ? message.sender.trim() : "the original sender";
  return { when, who };
}

/**
 * The quoted original as Mail writes it: a cite blockquote whose first line is
 * the attribution. The respond-draft script places the body (and the
 * signature) above it.
 *
 * @param {{sender?: string|null, dateSent?: string|null, dateReceived?: string|null, textBody?: string}} original
 * @param {{timeZone?: string, maxChars?: number}} opts
 */
export function buildReplyQuoteHtml(original, opts = {}) {
  const maxChars = opts.maxChars ?? MAX_QUOTED_CHARS;
  const { when, who } = whenAndWho(original, opts);
  const attribution = when ? `On ${when}, ${who} wrote:` : `${who} wrote:`;
  return `${CITE_OPEN}<div>${escapeHtml(attribution)}</div><br>${quotedOriginalHtml(original.textBody, maxChars)}${CITE_CLOSE}`;
}

/**
 * The forwarded message as Mail writes it: "Begin forwarded message:" and the
 * header lines with bold labels, then the text, all inside a cite blockquote.
 *
 * @param {{sender?: string|null, subject?: string|null, dateSent?: string|null, dateReceived?: string|null,
 *          to?: Array<{name?: string|null, address?: string|null}>, replyTo?: string|null, textBody?: string}} original
 * @param {{timeZone?: string, maxChars?: number}} opts
 */
export function buildForwardBlockHtml(original, opts = {}) {
  const maxChars = opts.maxChars ?? MAX_QUOTED_CHARS;
  const header = (label, value) => `<div><b>${label}: </b>${escapeHtml(value)}</div>`;
  const headers = [];
  if (original.sender) headers.push(header("From", original.sender));
  if (original.subject) headers.push(header("Subject", original.subject));
  const when = formatQuoteDate(original.dateSent ?? original.dateReceived ?? null, opts);
  if (when) headers.push(header("Date", when));
  const to = (original.to ?? []).map(formatAddress).filter((s) => s.length > 0);
  if (to.length > 0) headers.push(header("To", to.join(", ")));
  if (original.replyTo && original.replyTo !== original.sender) headers.push(header("Reply-To", original.replyTo));
  return (
    `${CITE_OPEN}<div>Begin forwarded message:</div><br>${headers.join("")}<br>` +
    `${quotedOriginalHtml(original.textBody, maxChars)}${CITE_CLOSE}`
  );
}
