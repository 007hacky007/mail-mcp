import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { runJxa as realRunJxa } from "../jxa/runner.mjs";
import { throwDomain } from "../mail/errors.mjs";
import { collectAttachments, parseMime } from "../mail/mime.mjs";
import { resolveSaveTarget } from "../mail/save-path.mjs";
import { guardArgs, InputError } from "./guard.mjs";

function defaultRoot() {
  return process.env.MAIL_MCP_SAVE_ROOT || join(homedir(), "Downloads");
}

export function createSaveAttachmentTool(deps = {}) {
  const { runJxa = realRunJxa, allowRoot } = deps;
  return {
    name: "save-attachment",
    description:
      "Write one attachment to disk, identified by the index from list-attachments. " +
      "Writes only under the allowlisted root (MAIL_MCP_SAVE_ROOT, default ~/Downloads), " +
      "never overwrites, and sanitizes filenames from mail. Returns where the file " +
      "landed; there is deliberately no tool that returns attachment bytes into the " +
      "conversation.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string", description: "Exact account name." },
        mailbox: { type: "string", description: "Full mailbox path the id belongs to." },
        id: { type: "integer", description: "Per-mailbox message id." },
        attachmentIndex: { type: "integer", description: "Index from list-attachments." },
        savePath: {
          type: "string",
          description:
            "Optional absolute target path; must resolve under the allowlisted root. " +
            "Defaults to the root plus the sanitized attachment filename.",
        },
      },
      required: ["account", "mailbox", "id", "attachmentIndex"],
      additionalProperties: false,
    },
    handler: async (args) => {
      guardArgs(args, {
        account: "string",
        mailbox: "string",
        id: "number",
        attachmentIndex: "number",
        savePath: "string",
      });
      if (typeof args.account !== "string") throw new InputError('Argument "account" is required.');
      if (typeof args.mailbox !== "string") throw new InputError('Argument "mailbox" is required.');
      if (!Number.isInteger(args.id)) throw new InputError('Argument "id" is required and must be an integer.');
      if (!Number.isInteger(args.attachmentIndex) || args.attachmentIndex < 0) {
        throw new InputError('Argument "attachmentIndex" is required and must be a non-negative integer.');
      }

      const { value } = await runJxa("get-source", [args.account, args.mailbox, String(args.id)], {
        timeoutMs: 120_000,
      });
      if (!value.ok) throwDomain(value.error);

      const attachments = collectAttachments(parseMime(value.source));
      if (args.attachmentIndex >= attachments.length) {
        throw new InputError(
          `The message has ${attachments.length} attachment(s); ` +
            (attachments.length === 0
              ? "there is nothing to save."
              : `valid attachmentIndex range is 0..${attachments.length - 1}.`)
        );
      }
      const attachment = attachments[args.attachmentIndex];

      const target = resolveSaveTarget({
        root: allowRoot ?? defaultRoot(),
        savePath: args.savePath,
        filename: attachment.filename,
        index: attachment.index,
      });
      // "wx" refuses to overwrite even if something appeared since the check.
      writeFileSync(target, attachment.body, { flag: "wx" });

      return {
        savedTo: target,
        filename: basename(target),
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
    },
  };
}
