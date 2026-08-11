import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs, InputError } from "./guard.mjs";

const DEFAULT_MAX_MESSAGES = 20_000;

export function requireIntInRange(value, name, min, max, fallback) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InputError(`Argument "${name}" must be an integer between ${min} and ${max}.`);
  }
  return value;
}

export function createListMessagesTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "list-messages",
    description:
      "Newest messages of one mailbox: id, subject, sender, date, read state, and the " +
      "mailbox path (ids are per-mailbox; the path is part of the identity). Mailboxes " +
      "over the size guard are refused with their count; raise maxMessages to read them " +
      "anyway, expecting tens of seconds.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Exact account name from list-accounts." },
        mailbox: { type: "string", description: "Full mailbox path from list-mailboxes." },
        limit: { type: "integer", default: 20, minimum: 1, maximum: 200 },
        maxMessages: {
          type: "integer",
          default: DEFAULT_MAX_MESSAGES,
          description: "Size guard: refuse mailboxes with more messages than this.",
        },
      },
      required: ["account", "mailbox"],
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, { account: "string", mailbox: "string", limit: "number", maxMessages: "number" });
      if (typeof args.account !== "string") throw new InputError('Argument "account" is required.');
      if (typeof args.mailbox !== "string") throw new InputError('Argument "mailbox" is required.');
      const limit = requireIntInRange(args.limit, "limit", 1, 200, 20);
      const maxMessages = requireIntInRange(args.maxMessages, "maxMessages", 1, 200_000, DEFAULT_MAX_MESSAGES);

      const { value } = await runJxa(
        "list-messages",
        [args.account, args.mailbox, String(limit), String(maxMessages)],
        // Six bulk arrays; ~1s per array per 17k messages, worse than linear
        // beyond that. A raised guard buys a raised budget.
        { timeoutMs: maxMessages > DEFAULT_MAX_MESSAGES ? 600_000 : 120_000 }
      );
      if (!value.ok) throwDomain(value.error);
      return { messageCount: value.messageCount, messages: value.messages };
    },
  };
}
