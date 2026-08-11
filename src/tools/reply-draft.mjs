import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs, InputError } from "./guard.mjs";

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

export function createReplyDraftTool(deps = {}) {
  const { runJxa = realRunJxa } = deps;
  return {
    name: "reply-draft",
    description:
      "Create a reply draft to an existing message (optionally reply-all) with the " +
      "given body above the quoted original, saved to Drafts. Nothing is sent; the " +
      "user reviews and sends from Mail.app.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Exact account name." },
        mailbox: { type: "string", description: "Full mailbox path the id belongs to." },
        id: { type: "integer", description: "Per-mailbox id of the message to reply to." },
        body: { type: "string", description: "Plain-text reply body." },
        replyAll: { type: "boolean", default: false },
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
      });
      if (typeof args.account !== "string") throw new InputError('Argument "account" is required.');
      if (typeof args.mailbox !== "string") throw new InputError('Argument "mailbox" is required.');
      if (!Number.isInteger(args.id)) throw new InputError('Argument "id" is required and must be an integer.');
      if (typeof args.body !== "string" || args.body.length === 0) {
        throw new InputError('Argument "body" is required.');
      }

      const { value } = await runJxa(
        "reply-draft",
        [args.account, args.mailbox, String(args.id), args.body, String(args.replyAll ?? false)],
        { timeoutMs: 60_000 }
      );
      if (!value.ok) throwDomain(value.error);
      refuseEmptyDraftBody(value.draft, "reply");
      return { draft: value.draft, note: DRAFT_NOTE };
    },
  };
}
