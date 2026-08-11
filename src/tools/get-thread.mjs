import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs, InputError } from "./guard.mjs";
import { requireIntInRange } from "./list-messages.mjs";

const DEFAULT_MAX_MESSAGES = 25_000;

export function createGetThreadTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "get-thread",
    description:
      "Messages related to the given one, grouped by the RFC References/In-Reply-To " +
      "chain when the message carries one, falling back to normalized-subject matching " +
      "otherwise (groupedBy in the output says which; each message says what matched " +
      "it). Scans the account's mailboxes under the size guard and reports skipped " +
      "mailboxes, so an incomplete thread is visible as such.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Exact account name." },
        mailbox: { type: "string", description: "Full mailbox path the id belongs to." },
        id: { type: "integer", description: "Per-mailbox message id of any message in the thread." },
        maxMessages: {
          type: "integer",
          default: DEFAULT_MAX_MESSAGES,
          description: "Size guard: mailboxes with more messages are skipped and reported.",
        },
      },
      required: ["account", "mailbox", "id"],
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, { account: "string", mailbox: "string", id: "number", maxMessages: "number" });
      if (typeof args.account !== "string") throw new InputError('Argument "account" is required.');
      if (typeof args.mailbox !== "string") throw new InputError('Argument "mailbox" is required.');
      if (!Number.isInteger(args.id)) throw new InputError('Argument "id" is required and must be an integer.');
      const maxMessages = requireIntInRange(args.maxMessages, "maxMessages", 1, 200_000, DEFAULT_MAX_MESSAGES);

      const { value } = await runJxa(
        "get-thread",
        [args.account, args.mailbox, String(args.id), String(maxMessages)],
        { timeoutMs: 600_000 }
      );
      if (!value.ok) throwDomain(value.error);

      const partial = value.skipped.length > 0;
      return {
        groupedBy: value.groupedBy,
        note:
          `Grouped by ${value.groupedBy}.` +
          (value.groupedBy === "subject"
            ? " The seed message carries no References/In-Reply-To headers, so this is the normalized-subject fallback; unrelated mail sharing the subject may appear."
            : "") +
          (partial ? ` Partial: ${value.skipped.length} mailbox(es) skipped, see skipped.` : ""),
        seed: value.seed,
        messages: value.messages,
        partial,
        scanned: value.scanned,
        skipped: value.skipped,
      };
    },
  };
}
