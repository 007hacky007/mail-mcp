import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs, InputError } from "./guard.mjs";

export function createGetUnreadCountTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "get-unread-count",
    description:
      "Unread message count, cheaply (Mail caches these counts; no message walk). " +
      "Defaults to the INBOX of every enabled account. Scope with account, and " +
      "optionally a full mailbox path within that account.",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Exact account name from list-accounts.",
        },
        mailbox: {
          type: "string",
          description:
            "Full mailbox path within the account (default INBOX). Requires account.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, { account: "string", mailbox: "string" });
      if (args.mailbox !== undefined && args.account === undefined) {
        throw new InputError(
          'Argument "mailbox" requires "account": mailbox paths are only unique within an account.'
        );
      }
      const { value } = await runJxa(
        "get-unread-count",
        [args.account ?? "", args.mailbox ?? ""],
        { timeoutMs: 60_000 }
      );
      if (!value.ok) throwDomain(value.error);

      const total = value.results.reduce((sum, r) => sum + r.unreadCount, 0);
      const partial = value.skipped.length > 0;
      return {
        total,
        partial,
        note: partial
          ? `Partial result: some scopes were skipped, so the total is a floor (at least ` +
            `${total} unread). See skipped for what is missing.`
          : "Complete across the scanned scope.",
        results: value.results,
        skipped: value.skipped,
      };
    },
  };
}
