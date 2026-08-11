import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs } from "./guard.mjs";

export function createListMailboxesTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "list-mailboxes",
    description:
      "List the mailbox tree with full paths. The full path (e.g. 'Parent/Sub') is the " +
      "identifier every other tool expects; leaf names collide across and even within " +
      "accounts. Counts are included by default but are the expensive part: a full " +
      "counted walk can take more than a minute on large accounts, so pass " +
      "includeCounts=false when only the structure is needed.",
    inputSchema: {
      type: "object",
      properties: {
        account: {
          type: "string",
          description: "Restrict to this account (exact name from list-accounts).",
        },
        includeCounts: {
          type: "boolean",
          default: true,
          description: "Include per-mailbox message and unread counts (slow on large accounts).",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, { account: "string", includeCounts: "boolean" });
      const account = args.account ?? "";
      const includeCounts = args.includeCounts ?? true;
      const { value } = await runJxa("list-mailboxes", [account, String(includeCounts)], {
        // A counted walk of this machine measured 20-75s; structure-only is seconds.
        timeoutMs: includeCounts ? 180_000 : 60_000,
      });
      if (!value.ok) throwDomain(value.error);
      return { accounts: value.accounts };
    },
  };
}
