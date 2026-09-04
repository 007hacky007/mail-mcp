import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs, InputError } from "./guard.mjs";
import { requireRecipients } from "./create-draft.mjs";
import { refuseEmptyDraftBody, fetchOriginal, shapeSignature, learnSignature } from "./reply-draft.mjs";
import { buildForwardBlockHtml, textToHtml } from "../mail/quote.mjs";
import { signatureCache as defaultSignatureCache } from "../mail/signature-cache.mjs";

const DRAFT_NOTE =
  "The draft has not been sent, and this server has no way to send it: review it in " +
  "Mail.app's Drafts folder and press Send yourself.";

export function createForwardDraftTool(deps = {}) {
  const { runJxa = realRunJxa, signatureCache = defaultSignatureCache } = deps;
  return {
    name: "forward-draft",
    description:
      "Create a forward draft of an existing message to the given recipients, with an " +
      "optional note above the forwarded content, saved to Drafts. Without a note, Mail " +
      "builds the forwarded block itself. With a note, this server reproduces it in " +
      "Mail's own shape ('Begin forwarded message:', From/Subject/Date/To, and the " +
      "original text, all inside a cite blockquote), because Mail's scripting bridge " +
      "discards the forwarded message whenever a body is set; the account signature " +
      "goes between the note and the forwarded block, as in Mail. Attachments of the " +
      "original are not expected to carry over in that case; leave the note empty to " +
      "get Mail's own forward. Nothing is sent; the user reviews and sends from Mail.app.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Exact account name." },
        mailbox: { type: "string", description: "Full mailbox path the id belongs to." },
        id: { type: "integer", description: "Per-mailbox id of the message to forward." },
        to: { type: "array", items: { type: "string" }, description: "Recipient addresses." },
        body: { type: "string", description: "Optional note placed above the forwarded content." },
      },
      required: ["account", "mailbox", "id", "to"],
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, {
        account: "string",
        mailbox: "string",
        id: "number",
        to: "string[]",
        body: "string",
      });
      if (typeof args.account !== "string") throw new InputError('Argument "account" is required.');
      if (typeof args.mailbox !== "string") throw new InputError('Argument "mailbox" is required.');
      if (!Number.isInteger(args.id)) throw new InputError('Argument "id" is required and must be an integer.');
      const to = requireRecipients(args.to, "to");

      const note = args.body ?? "";
      const bodyHtml = note.length > 0 ? textToHtml(note) : "";
      const blockHtml = note.length > 0 ? buildForwardBlockHtml(await fetchOriginal(runJxa, args)) : "";

      const { value } = await runJxa(
        "respond-draft",
        [
          "forward",
          args.account,
          args.mailbox,
          String(args.id),
          JSON.stringify(to),
          bodyHtml,
          blockHtml,
          "false",
          JSON.stringify(signatureCache.snapshot()),
        ],
        { timeoutMs: 60_000 }
      );
      if (!value.ok) throwDomain(value.error);
      refuseEmptyDraftBody(value.draft, "forward");
      learnSignature(signatureCache, value);
      const out = { draft: value.draft, signature: shapeSignature(value), note: DRAFT_NOTE };
      if (typeof value.warning === "string") out.warning = value.warning;
      return out;
    },
  };
}
