import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs, InputError } from "./guard.mjs";
import { requireIntInRange } from "./list-messages.mjs";

const DEFAULT_MAX_MESSAGES = 20_000;
const SEARCHABLE_FIELDS = ["subject", "sender"];

function requireIsoDate(value, name) {
  if (value === undefined || value === null) return "";
  if (Number.isNaN(Date.parse(value))) {
    throw new InputError(`Argument "${name}" must be an ISO 8601 date, e.g. 2026-08-01 or 2026-08-01T12:00:00Z.`);
  }
  return new Date(value).toISOString();
}

export function createSearchMessagesTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "search-messages",
    description:
      "Case-insensitive substring search over subject and/or sender, with an optional " +
      "date range, across all enabled accounts or a narrower scope. Reports every " +
      "mailbox scanned AND every mailbox skipped (size guard or error), so an empty " +
      "result is never ambiguous between 'nothing matched' and 'gave up'. Message " +
      "bodies are not searched: fetching every body through the scripting bridge " +
      "would take minutes and gigabytes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Substring to match (case-insensitive)." },
        fields: {
          type: "array",
          items: { type: "string", enum: SEARCHABLE_FIELDS },
          default: SEARCHABLE_FIELDS,
          description: "Which fields the query matches against.",
        },
        account: { type: "string", description: "Exact account name to scope to." },
        mailbox: { type: "string", description: "Full mailbox path (requires account)." },
        dateFrom: { type: "string", description: "ISO date; only messages received on/after." },
        dateTo: { type: "string", description: "ISO date; only messages received on/before." },
        limit: { type: "integer", default: 50, minimum: 1, maximum: 500 },
        maxMessages: {
          type: "integer",
          default: DEFAULT_MAX_MESSAGES,
          description: "Size guard: mailboxes with more messages are skipped and reported.",
        },
      },
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, {
        query: "string",
        fields: "string[]",
        account: "string",
        mailbox: "string",
        dateFrom: "string",
        dateTo: "string",
        limit: "number",
        maxMessages: "number",
      });
      const query = args.query ?? "";
      const dateFrom = requireIsoDate(args.dateFrom, "dateFrom");
      const dateTo = requireIsoDate(args.dateTo, "dateTo");
      if (!query && !dateFrom && !dateTo) {
        throw new InputError("Provide a query, a dateFrom/dateTo bound, or both.");
      }
      const fields = args.fields ?? SEARCHABLE_FIELDS;
      const unknown = fields.filter((f) => !SEARCHABLE_FIELDS.includes(f));
      if (unknown.length > 0 || fields.length === 0) {
        throw new InputError(`Argument "fields" accepts only: ${SEARCHABLE_FIELDS.join(", ")}.`);
      }
      if (args.mailbox !== undefined && args.account === undefined) {
        throw new InputError('Argument "mailbox" requires "account": mailbox paths are only unique within an account.');
      }
      const limit = requireIntInRange(args.limit, "limit", 1, 500, 50);
      const maxMessages = requireIntInRange(args.maxMessages, "maxMessages", 1, 200_000, DEFAULT_MAX_MESSAGES);

      const { value } = await runJxa(
        "search-messages",
        [
          args.account ?? "",
          args.mailbox ?? "",
          query,
          fields.join(","),
          dateFrom,
          dateTo,
          String(limit),
          String(maxMessages),
        ],
        { timeoutMs: 600_000 }
      );
      if (!value.ok) throwDomain(value.error);

      const partial = value.skipped.length > 0;
      return {
        hits: value.hits,
        matchCount: value.matchCount,
        truncated: value.truncated,
        partial,
        note: partial
          ? `Partial scan: ${value.skipped.length} mailbox(es) were skipped (see skipped); ` +
            `matches there would not appear here. matchCount is a floor.`
          : "Scan complete: every mailbox in scope was searched.",
        scanned: value.scanned,
        skipped: value.skipped,
      };
    },
  };
}
