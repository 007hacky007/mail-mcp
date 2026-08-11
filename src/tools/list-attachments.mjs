import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { collectAttachments, parseMime } from "../mail/mime.mjs";
import { guardArgs, InputError } from "./guard.mjs";

export function createListAttachmentsTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "list-attachments",
    description:
      "Name, MIME type and size of each attachment of a message, parsed from the raw " +
      "MIME source (Mail's own attachment objects report unreliable names and types). " +
      "Returns metadata only, never attachment content; use save-attachment to write " +
      "one to disk.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Exact account name." },
        mailbox: { type: "string", description: "Full mailbox path the id belongs to." },
        id: { type: "integer", description: "Per-mailbox message id." },
      },
      required: ["account", "mailbox", "id"],
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, { account: "string", mailbox: "string", id: "number" });
      if (typeof args.account !== "string") throw new InputError('Argument "account" is required.');
      if (typeof args.mailbox !== "string") throw new InputError('Argument "mailbox" is required.');
      if (!Number.isInteger(args.id)) throw new InputError('Argument "id" is required and must be an integer.');

      const { value } = await runJxa("get-source", [args.account, args.mailbox, String(args.id)], {
        timeoutMs: 120_000,
      });
      if (!value.ok) throwDomain(value.error);

      const attachments = collectAttachments(parseMime(value.source)).map(
        ({ index, filename, mimeType, sizeBytes, disposition, contentId }) => ({
          index,
          filename,
          mimeType,
          sizeBytes,
          disposition,
          contentId,
        })
      );
      return {
        attachments,
        note:
          attachments.length === 0
            ? "The message has no attachments (parsed from its MIME source)."
            : `${attachments.length} attachment(s). Use save-attachment with the index to write one to disk.`,
      };
    },
  };
}
