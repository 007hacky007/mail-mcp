import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { guardArgs, InputError } from "./guard.mjs";

const DRAFT_NOTE =
  "The draft has not been sent, and this server has no way to send it: review it in " +
  "Mail.app's Drafts folder and press Send yourself.";

export function requireRecipients(value, name) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new InputError(`Argument "${name}" must be a non-empty array of email addresses.`);
  }
  for (const addr of value) {
    if (typeof addr !== "string" || !addr.includes("@") || addr.trim().length < 3) {
      throw new InputError(`Argument "${name}" contains an invalid address: ${JSON.stringify(addr)}.`);
    }
  }
  return value;
}

export function createCreateDraftTool(deps = {}) {
  const { runJxa = realRunJxa, fileExists = existsSync } = deps;
  return {
    name: "create-draft",
    description:
      "Create a draft email in Mail.app's Drafts folder: recipients, subject, body, " +
      "and optional attachments (absolute file paths). Nothing is sent; this server " +
      "has no send capability at all. The user reviews and sends from Mail.app.",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "array", items: { type: "string" }, description: "Recipient addresses." },
        cc: { type: "array", items: { type: "string" } },
        bcc: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string", description: "Plain-text body." },
        attachments: {
          type: "array",
          items: { type: "string" },
          description: "Absolute paths of files to attach.",
        },
      },
      required: ["to", "subject", "body"],
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, {
        to: "string[]",
        cc: "string[]",
        bcc: "string[]",
        subject: "string",
        body: "string",
        attachments: "string[]",
      });
      const to = requireRecipients(args.to, "to");
      const cc = args.cc ?? [];
      const bcc = args.bcc ?? [];
      if (cc.length > 0) requireRecipients(cc, "cc");
      if (bcc.length > 0) requireRecipients(bcc, "bcc");
      if (typeof args.subject !== "string" || args.subject.length === 0) {
        throw new InputError('Argument "subject" is required.');
      }
      if (typeof args.body !== "string") {
        throw new InputError('Argument "body" is required.');
      }
      const attachments = args.attachments ?? [];
      for (const p of attachments) {
        if (!isAbsolute(p)) {
          throw new InputError(`Attachment path must be absolute: ${JSON.stringify(p)}.`);
        }
        if (!fileExists(p)) {
          throw new InputError(`Attachment file does not exist: ${JSON.stringify(p)}.`);
        }
      }

      const { value } = await runJxa(
        "create-draft",
        [
          JSON.stringify(to),
          JSON.stringify(cc),
          JSON.stringify(bcc),
          args.subject,
          args.body,
          JSON.stringify(attachments),
        ],
        { timeoutMs: 60_000 }
      );
      if (!value.ok) throwDomain(value.error);
      return { draft: value.draft, note: DRAFT_NOTE };
    },
  };
}
