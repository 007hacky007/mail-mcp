/**
 * Minimal MIME parser for message `source`. Exists because Mail's attachment
 * objects report unreliable names/types and because upstream once returned
 * the entire raw MIME blob mislabeled as the HTML body; parsing the source
 * ourselves is what prevents both. Pure functions, no I/O, fully unit-tested.
 */

/** Split raw source into header block and body at the first empty line. */
function splitHeadersBody(text) {
  const match = text.match(/\r?\n\r?\n/);
  if (!match) return { headerText: text, bodyText: "" };
  return {
    headerText: text.slice(0, match.index),
    bodyText: text.slice(match.index + match[0].length),
  };
}

/** Unfold and parse a header block into an ordered [{name, value}] list. */
function parseHeaders(headerText) {
  const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
  const headers = [];
  for (const line of unfolded.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    headers.push({ name: line.slice(0, idx).trim(), value: line.slice(idx + 1).trim() });
  }
  return headers;
}

function getHeader(headers, name) {
  const lower = name.toLowerCase();
  const found = headers.find((h) => h.name.toLowerCase() === lower);
  return found ? found.value : null;
}

/** Parse "type/subtype; key=value; key="value"" into {value, params}. */
function parseParameterized(headerValue) {
  if (!headerValue) return { value: "", params: {} };
  const [value, ...rest] = headerValue.split(";");
  const params = {};
  const paramText = rest.join(";");
  const re = /([A-Za-z0-9_*-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/g;
  let m;
  while ((m = re.exec(paramText)) !== null) {
    params[m[1].toLowerCase()] = (m[2] !== undefined ? m[2].replace(/\\(.)/g, "$1") : m[3]) ?? "";
  }
  return { value: value.trim().toLowerCase(), params };
}

function decodeBody(bodyText, encoding) {
  const enc = (encoding || "7bit").trim().toLowerCase();
  if (enc === "base64") {
    return Buffer.from(bodyText.replace(/[^A-Za-z0-9+/=]/g, ""), "base64");
  }
  if (enc === "quoted-printable") {
    const withoutSoftBreaks = bodyText.replace(/=\r?\n/g, "");
    const bytes = [];
    for (let i = 0; i < withoutSoftBreaks.length; i++) {
      const ch = withoutSoftBreaks[i];
      if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(withoutSoftBreaks.slice(i + 1, i + 3))) {
        bytes.push(parseInt(withoutSoftBreaks.slice(i + 1, i + 3), 16));
        i += 2;
      } else {
        // Header/body text is already latin1-safe at this layer; charset
        // decoding happens on the assembled bytes below.
        bytes.push(ch.charCodeAt(0) & 0xff);
      }
    }
    return Buffer.from(bytes);
  }
  // 7bit / 8bit / binary / unknown: bytes as-is (latin1 preserves each byte).
  return Buffer.from(bodyText, "latin1");
}

function decodeCharset(buffer, charset) {
  const name = (charset || "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(name, { fatal: false }).decode(buffer);
  } catch {
    // Unknown charset label: utf-8 best effort beats an exception; the bytes
    // are still shown, just possibly with replacement characters.
    return new TextDecoder("utf-8", { fatal: false }).decode(buffer);
  }
}

/**
 * Parse a raw RFC 822 / MIME message into a part tree:
 * { headers, contentType: {value, params}, disposition: {value, params},
 *   encoding, body: Buffer|null, parts: [] }
 * Leaf parts carry decoded body bytes; multiparts carry children instead.
 */
export function parseMime(source) {
  const { headerText, bodyText } = splitHeadersBody(source);
  const headers = parseHeaders(headerText);
  const contentType = parseParameterized(getHeader(headers, "Content-Type") ?? "text/plain");
  const disposition = parseParameterized(getHeader(headers, "Content-Disposition") ?? "");
  const encoding = getHeader(headers, "Content-Transfer-Encoding") ?? "7bit";

  const node = { headers, contentType, disposition, encoding, body: null, parts: [] };

  const boundary = contentType.params.boundary;
  if (contentType.value.startsWith("multipart/") && boundary) {
    // Split on delimiter lines. The preamble (before the first delimiter)
    // and epilogue (after the closing one) are ignored per RFC 2046.
    const lines = bodyText.split(/\r?\n/);
    const delimiter = `--${boundary}`;
    const closing = `--${boundary}--`;
    let current = null;
    const rawParts = [];
    for (const line of lines) {
      const trimmed = line.trimEnd();
      if (trimmed === delimiter) {
        current = [];
        rawParts.push(current);
        continue;
      }
      if (trimmed === closing) {
        current = null;
        continue;
      }
      if (current) current.push(line);
    }
    node.parts = rawParts.map((partLines) => parseMime(partLines.join("\r\n")));
  } else {
    node.body = decodeBody(bodyText, encoding);
  }
  return node;
}

/** Depth-first list of leaf parts (parts with no children). */
export function leafParts(node) {
  if (node.parts.length === 0) return [node];
  return node.parts.flatMap(leafParts);
}

/**
 * The HTML BODY of the message: a text/html leaf that is not an attachment.
 * Returns the decoded string, or null when the message has none - never the
 * raw source, which is the upstream bug this module exists to prevent.
 */
export function findHtmlBody(tree) {
  for (const leaf of leafParts(tree)) {
    if (leaf.contentType.value !== "text/html") continue;
    if (leaf.disposition.value === "attachment") continue;
    return decodeCharset(leaf.body, leaf.contentType.params.charset);
  }
  return null;
}
