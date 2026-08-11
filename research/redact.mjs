const STANDARD_MAILBOXES = new Set([
  "INBOX", "Inbox", "Sent", "Sent Messages", "Sent Items", "Drafts",
  "Trash", "Deleted Messages", "Junk", "Spam", "Archive",
  "All Mail", "Important", "Starred", "[Gmail]", "[Google Mail]",
]);

const EMAIL_PATTERN = "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}";
// Bug fix beyond the brief's Step 3 (see task-2-report.md): a bare
// .replace(DISPLAY_ADDR_RE, ...).replace(EMAIL_RE, ...) chain re-scans its
// own output, so the "userN@example.com" pseudonym just inserted by the
// first pass gets matched again by the second and reassigned a new number.
// One combined pass, tried left-to-right per match position, avoids ever
// re-scanning already-substituted text.
const ADDR_OR_EMAIL_RE = new RegExp(`"?([^"<>]+?)"?\\s*<([^<>]+)>|(${EMAIL_PATTERN})`, "g");
const ACCOUNT_LABELS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Rule table extension beyond the brief (see task-2-report.md, Step 6): a
// live probe against real Mail.app data showed that "name" nested under
// "mailboxes"/"boxes" is not the only natural shape a probe emits for a list
// of mailbox names -- the more direct JXA idiom `mailboxes().map(m =>
// m.name())` produces a bare array of strings, which the original rule set
// gave zero protection: real, non-standard folder names passed through
// completely verbatim. Same reasoning applies to a bare array of account
// labels. These are additional accepted key names for that same bare-string-
// array shape, not a replacement for the object-array form above.
const FOLDER_ARRAY_KEYS = new Set(["mailboxNames", "folderNames", "boxNames"]);
const ACCOUNT_ARRAY_KEYS = new Set(["accountNames"]);

export function newRedactor() {
  const emails = new Map();
  const people = new Map();
  const accounts = new Map();
  const folders = new Map();

  const pseudoEmail = (addr) => {
    const key = addr.trim().toLowerCase();
    if (!emails.has(key)) emails.set(key, `user${emails.size + 1}@example.com`);
    return emails.get(key);
  };
  const pseudoPerson = (name) => {
    const key = name.trim().toLowerCase();
    if (!people.has(key)) people.set(key, `Person ${people.size + 1}`);
    return people.get(key);
  };
  const pseudoAccount = (name) => {
    if (!accounts.has(name)) {
      const i = accounts.size;
      accounts.set(name, `Account ${ACCOUNT_LABELS[i] ?? `Z${i}`}`);
    }
    return accounts.get(name);
  };
  const pseudoFolder = (name) => {
    if (STANDARD_MAILBOXES.has(name)) return name;
    if (!folders.has(name)) folders.set(name, `Folder ${folders.size + 1}`);
    return folders.get(name);
  };

  const scrubText = (s) =>
    s.replace(ADDR_OR_EMAIL_RE, (_m, name, addr, bareEmail) =>
      bareEmail !== undefined
        ? pseudoEmail(bareEmail)
        : `"${pseudoPerson(name)}" <${pseudoEmail(addr)}>`
    );

  const describeSubject = (s) => {
    const chars = /^[\x20-\x7e]*$/.test(s) ? "ascii" : "unicode";
    return `<subject len=${[...s].length} chars=${chars}>`;
  };

  const walk = (value, keyPath) => {
    const key = keyPath.at(-1);
    const parent = [...keyPath].slice(0, -1).reverse().find((p) => !/^\d+$/.test(p));

    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...keyPath, String(i)]));
    if (value && typeof value === "object") {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v, [...keyPath, k]);
      return out;
    }
    if (typeof value !== "string") return value;

    if (key === "subject") return describeSubject(value);
    if (
      key === "accountName" ||
      (key === "name" && parent === "accounts") ||
      ACCOUNT_ARRAY_KEYS.has(parent)
    ) {
      return pseudoAccount(value);
    }
    if (
      (key === "name" && (parent === "mailboxes" || parent === "boxes")) ||
      FOLDER_ARRAY_KEYS.has(parent)
    ) {
      return pseudoFolder(value);
    }
    if (key === "path" || key === "fullPath") {
      return value.split("/").map(pseudoFolder).join("/");
    }
    return scrubText(value);
  };

  return (value) => walk(value, []);
}

export const redact = (value) => newRedactor()(value);
