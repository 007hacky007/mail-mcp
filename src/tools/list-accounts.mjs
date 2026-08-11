import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { guardArgs } from "./guard.mjs";

export function createListAccountsTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "list-accounts",
    description:
      "List every configured Mail account: name, enabled state, account type, email " +
      "addresses, and mailbox count. Disabled accounts are included with enabled=false; " +
      "they are switched off in Mail, not broken, and have zero mailboxes.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (args) => {
      guardArgs(args, {});
      const { value } = await runJxa("list-accounts", [], { timeoutMs: 30_000 });
      return { accounts: value.accounts };
    },
  };
}
