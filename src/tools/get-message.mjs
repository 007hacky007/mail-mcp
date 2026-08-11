import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { findHtmlBody, parseMime } from "../mail/mime.mjs";
import { guardArgs, InputError } from "./guard.mjs";

const TEXT_BODY_CAP = 200_000;
const HTML_BODY_CAP = 500_000;

function capText(text, cap) {
  if (typeof text !== "string" || text.length <= cap) {
    return { text, truncated: false, totalChars: typeof text === "string" ? text.length : 0 };
  }
  return { text: text.slice(0, cap), truncated: true, totalChars: text.length };
}

export function createGetMessageTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "get-message",
    description:
      "One message in full: headers, recipients, flags, and the plain-text body. " +
      "Needs the account, the full mailbox path, and the id exactly as returned by " +
      "list-messages/search-messages (ids are per-mailbox and do not survive moves). " +
      "includeHtml additionally fetches and parses the raw source to extract the HTML " +
      "body part; leave it off otherwise, sources can be tens of megabytes.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Exact account name." },
        mailbox: { type: "string", description: "Full mailbox path the id belongs to." },
        id: { type: "integer", description: "Per-mailbox message id." },
        includeHtml: {
          type: "boolean",
          default: false,
          description: "Fetch the raw source and extract the HTML body part.",
        },
      },
      required: ["account", "mailbox", "id"],
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, { account: "string", mailbox: "string", id: "number", includeHtml: "boolean" });
      if (typeof args.account !== "string") throw new InputError('Argument "account" is required.');
      if (typeof args.mailbox !== "string") throw new InputError('Argument "mailbox" is required.');
      if (!Number.isInteger(args.id)) throw new InputError('Argument "id" is required and must be an integer.');
      const includeHtml = args.includeHtml ?? false;

      const { value } = await runJxa(
        "get-message",
        [args.account, args.mailbox, String(args.id), String(includeHtml)],
        { timeoutMs: 120_000 }
      );
      if (!value.ok) throwDomain(value.error);

      const message = value.message;
      const text = capText(message.textBody, TEXT_BODY_CAP);
      const out = {
        ...message,
        textBody: text.text,
      };
      if (text.truncated) {
        out.textBodyTruncated = true;
        out.textBodyTotalChars = text.totalChars;
      }

      if (includeHtml) {
        // Parse the source ourselves and extract only the HTML body part.
        // Returning raw source mislabeled as HTML was a real upstream bug.
        const html = typeof value.source === "string" ? findHtmlBody(parseMime(value.source)) : null;
        if (html === null) {
          out.htmlBody = null;
          out.htmlNote = "The message has no HTML body part.";
        } else {
          const capped = capText(html, HTML_BODY_CAP);
          out.htmlBody = capped.text;
          if (capped.truncated) {
            out.htmlBodyTruncated = true;
            out.htmlBodyTotalChars = capped.totalChars;
          }
        }
      }
      return out;
    },
  };
}
