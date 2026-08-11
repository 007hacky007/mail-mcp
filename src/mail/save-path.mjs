/**
 * Path handling for save-attachment, the only code in this tree that writes
 * to the filesystem. Attachment filenames arrive from mail, which is
 * attacker-controlled input, so nothing here trusts them; and every explicit
 * target is contained to the allowlisted root AFTER resolving symlinks.
 */
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, sep } from "node:path";

const MAX_NAME_LENGTH = 200;

/**
 * Reduce an untrusted filename to a safe basename, or null if nothing usable
 * remains. Strips directory components (both separators), control characters,
 * characters that are unsafe on common filesystems, and leading dots (no
 * hidden files, no "." / "..").
 */
export function sanitizeFilename(name) {
  if (typeof name !== "string") return null;
  const lastSegment = name.split(/[/\\]/).filter((s) => s.length > 0).pop() ?? "";
  let out = lastSegment
    .replace(/[\x00-\x1f\x7f]/g, "")
    .replace(/[:|?*"<>]/g, "_")
    .replace(/^\.+/, "")
    .trim();
  if (out.length === 0) return null;
  if (out.length > MAX_NAME_LENGTH) {
    const ext = extname(out);
    out = out.slice(0, MAX_NAME_LENGTH - ext.length) + ext;
  }
  return out;
}

/**
 * Decide where the attachment may be written, or throw. The returned path is
 * guaranteed to sit under `root` after symlink resolution of its directory,
 * and to not exist yet (existing files are refused, never overwritten).
 */
export function resolveSaveTarget({ root, savePath, filename, index }) {
  const rootReal = realpathSync(root);

  let target;
  if (savePath !== undefined && savePath !== null) {
    if (!isAbsolute(savePath)) {
      throw new Error(`savePath must be an absolute path under the allowlisted root (${rootReal}).`);
    }
    const dir = dirname(savePath);
    if (!existsSync(dir)) {
      throw new Error(`The directory ${dir} does not exist. Create it first or omit savePath.`);
    }
    // realpath resolves symlinked parents, so a link inside the root cannot
    // smuggle the write outside it.
    const dirReal = realpathSync(dir);
    if (dirReal !== rootReal && !dirReal.startsWith(rootReal + sep)) {
      throw new Error(
        `savePath resolves to ${dirReal}, outside the allowlisted root (${rootReal}). ` +
          `Writes are confined to that root.`
      );
    }
    const name = sanitizeFilename(basename(savePath));
    if (name === null) {
      throw new Error("savePath has no usable file name component.");
    }
    target = join(dirReal, name);
  } else {
    const name = sanitizeFilename(filename) ?? `attachment-${index}`;
    target = join(rootReal, name);
  }

  let exists = false;
  try {
    lstatSync(target);
    exists = true;
  } catch {
    // Does not exist: exactly what is wanted.
  }
  if (exists) {
    throw new Error(
      `${target} already exists. This tool never overwrites; pass savePath with a different name.`
    );
  }
  return target;
}
