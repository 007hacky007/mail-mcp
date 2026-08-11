import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs, InputError } from "./guard.mjs";
import { requireRecipients } from "./create-draft.mjs";
import { refuseEmptyDraftBody } from "./reply-draft.mjs";

const DRAFT_NOTE =
  "The draft has not been sent, and this server has no way to send it: review it in " +
  "Mail.app's Drafts folder and press Send yourself.";

export function createForwardDraftTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "forward-draft",
    description:
      "Create a forward draft of an existing message to the given recipients, with an " +
      "optional note above the forwarded content, saved to Drafts. Nothing is sent; " +
      "the user reviews and sends from Mail.app.",
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

      const { value } = await runJxa(
        "forward-draft",
        [args.account, args.mailbox, String(args.id), JSON.stringify(to), args.body ?? ""],
        { timeoutMs: 60_000 }
      );
      if (!value.ok) throwDomain(value.error);
      refuseEmptyDraftBody(value.draft, "forward");
      return { draft: value.draft, note: DRAFT_NOTE };
    },
  };
}
