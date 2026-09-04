import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs, InputError } from "./guard.mjs";
import { buildReplyQuoteHtml, textToHtml } from "../mail/quote.mjs";
import { signatureCache as defaultSignatureCache } from "../mail/signature-cache.mjs";

const DRAFT_NOTE =
  "The draft has not been sent, and this server has no way to send it: review it in " +
  "Mail.app's Drafts folder and press Send yourself.";

/**
 * An empty saved body is the exact upstream failure the without-opening-window
 * recipe prevents (set content silently no-ops with a compose window). If it
 * ever comes back empty, that is a failure to report, never a success.
 */
export function refuseEmptyDraftBody(draft, what) {
  if (draft.contentLength === 0) {
    throw new Error(
      `Mail saved the ${what} draft with an empty body: the 'set content' silently ` +
        `no-opped, which is a known Mail failure mode when a compose window is ` +
        `involved. The draft in Drafts is broken; delete it and retry. If this ` +
        `repeats, Mail's scripting behavior has changed - please report it.`
    );
  }
}

/**
 * Fetch the message a reply or forward is built on, through the same script
 * get-message uses, so the quote below the body is the real original. Mail
 * discards its own quote the moment `content` is set (measured 2026-09-04,
 * docs/apple-mail/README.md), which is why the server has to quote at all.
 */
export async function fetchOriginal(runJxa, { account, mailbox, id }) {
  const { value } = await runJxa("get-message", [account, mailbox, String(id), "false"], {
    timeoutMs: 60_000,
  });
  if (!value.ok) throwDomain(value.error);
  return value.message;
}

/** The script's signature report, minus the HTML that only the cache needs. */
export function shapeSignature(value) {
  const s = value.signature;
  if (!s || typeof s !== "object") return null;
  return { name: s.name ?? null, placement: s.placement ?? "unknown" };
}

/** Remember a signature the script harvested so the next draft needs one save. */
export function learnSignature(cache, value) {
  const s = value.signature;
  if (s && s.harvested === true) cache.remember(s.name, s.html);
}

export function createReplyDraftTool(deps = {}) {
  const { runJxa = realRunJxa, signatureCache = defaultSignatureCache } = deps;
  return {
    name: "reply-draft",
    description:
      "Create a reply draft to an existing message (optionally reply-all), saved to " +
      "Drafts. By default the original message is quoted below the body the way Mail " +
      "itself does it: an 'On <date>, <sender> wrote:' line and the original text in a " +
      "cite blockquote that Mail renders with its vertical quote bar. This server builds " +
      "that quote because Mail's scripting bridge drops its own quote whenever a body is " +
      "set. Pass quoteOriginal=false for a clean reply with no quote. The body is plain " +
      "text; lines starting with '>' become nested quote levels, any other markup is " +
      "shown literally. The account signature is placed between the body and the " +
      "quote, as in a reply composed in Mail (the first draft per signature in a " +
      "server run saves twice to read the signature's HTML back; the result reports " +
      "where the signature ended up). Threading headers (In-Reply-To, References) and " +
      "recipients come from Mail. Nothing is sent; the user reviews and sends from Mail.app.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Exact account name." },
        mailbox: { type: "string", description: "Full mailbox path the id belongs to." },
        id: { type: "integer", description: "Per-mailbox id of the message to reply to." },
        body: { type: "string", description: "Plain-text reply body, placed above the quote." },
        replyAll: { type: "boolean", default: false },
        quoteOriginal: {
          type: "boolean",
          default: true,
          description: "Quote the original message below the body. False gives a clean reply.",
        },
      },
      required: ["account", "mailbox", "id", "body"],
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, {
        account: "string",
        mailbox: "string",
        id: "number",
        body: "string",
        replyAll: "boolean",
        quoteOriginal: "boolean",
      });
      if (typeof args.account !== "string") throw new InputError('Argument "account" is required.');
      if (typeof args.mailbox !== "string") throw new InputError('Argument "mailbox" is required.');
      if (!Number.isInteger(args.id)) throw new InputError('Argument "id" is required and must be an integer.');
      if (typeof args.body !== "string" || args.body.length === 0) {
        throw new InputError('Argument "body" is required.');
      }

      const quoteOriginal = args.quoteOriginal !== false;
      const bodyHtml = textToHtml(args.body);
      const quoteHtml = quoteOriginal ? buildReplyQuoteHtml(await fetchOriginal(runJxa, args)) : "";

      const { value } = await runJxa(
        "respond-draft",
        [
          "reply",
          args.account,
          args.mailbox,
          String(args.id),
          "[]",
          bodyHtml,
          quoteHtml,
          String(args.replyAll ?? false),
          JSON.stringify(signatureCache.snapshot()),
        ],
        { timeoutMs: 60_000 }
      );
      if (!value.ok) throwDomain(value.error);
      refuseEmptyDraftBody(value.draft, "reply");
      learnSignature(signatureCache, value);
      const out = { draft: value.draft, quotedOriginal: quoteOriginal, signature: shapeSignature(value), note: DRAFT_NOTE };
      if (typeof value.warning === "string") out.warning = value.warning;
      return out;
    },
  };
}
