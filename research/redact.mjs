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

// Folder-context keys: a "name" nested under one of these (at any depth,
// skipping numeric array indices) is a mailbox/folder display name; a bare
// string sitting directly in an array under one of these is too. Fix for
// review findings 1.7/1.8 (task-2-review.md): "children" (nested
// sub-mailboxes) and the un-suffixed "mailboxes"/"boxes" keys themselves
// (a bare array of strings under the very key this file already trusts)
// both leaked before - the original set only covered the *Names synonyms.
const FOLDER_KEYS = new Set([
  "mailboxes", "boxes", "children", "mailboxnames", "foldernames", "boxnames",
]);
const ACCOUNT_ARRAY_KEYS = new Set(["accounts", "accountnames"]);

// Round-2 architectural fix (see task-2-report.md, "Fix: invert redaction
// to fail closed"): the original design was an ALLOWLIST OF KEY NAMES THAT
// TRIGGER REDACTION, with scrubText as a fallback that mostly passed
// unrecognized values straight through with only literal email patterns
// stripped. That fails OPEN - any key or shape the rules don't recognize
// leaks its value close to verbatim. VERBATIM_KEYS + SAFE_VALUE_PATTERN are
// now the only escape hatch for a string that isn't caught by an
// identity-preserving structural rule, a content-based email/address
// match, or the standard-mailbox allowlist; everything else collapses to
// an opaque length/class descriptor - fail closed by default.
const VERBATIM_KEYS = new Set([
  "probe", "mode", "ok", "type", "idtype", "accounttype", "chars", "status",
]);
const SAFE_VALUE_PATTERN = /^[A-Za-z0-9 _.,:;()+-]{1,40}$/;

// Object keys are, in real JXA/probe output, essentially always
// programmer-chosen identifiers (subject, dateReceived, mailboxNames,
// __proto__, ...) - never natural-language content. So, unlike values,
// "looks like a plain identifier" (no "@", no spaces, no punctuation
// beyond underscore/dollar, reasonably short) is a reasonable default-safe
// signal for KEY text specifically (review finding 1.9: an object key can
// itself be a real address or a display name, and the old code never
// touched keys at all). A key that fails this pattern is treated as
// carrying data, not schema, and is redacted the same way a value would be.
const SAFE_KEY_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

const isNumericSegment = (s) => /^\d+$/.test(s);

export function newRedactor() {
  const emails = new Map();
  const people = new Map();
  const accounts = new Map();
  const folders = new Map();
  const genericKeys = new Map();

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
  // Fallback for an unsafe object KEY that isn't itself email-shaped
  // (e.g. a bare display name used as a key, review finding 1.9). A
  // dedicated per-redactor map (not the length/class descriptor used for
  // values) guarantees two different original keys can never collapse
  // onto the same output key, which would silently shrink the key set.
  const pseudoGenericKey = (k) => {
    if (!genericKeys.has(k)) genericKeys.set(k, `redactedKey${genericKeys.size + 1}`);
    return genericKeys.get(k);
  };

  const scrubText = (s) =>
    s.replace(ADDR_OR_EMAIL_RE, (_m, name, addr, bareEmail) =>
      bareEmail !== undefined
        ? pseudoEmail(bareEmail)
        : `"${pseudoPerson(name)}" <${pseudoEmail(addr)}>`
    );

  const charClass = (s) => (/^[\x20-\x7e]*$/.test(s) ? "ascii" : "unicode");
  const describeSubject = (s) => `<subject len=${[...s].length} chars=${charClass(s)}>`;
  const describeGeneric = (s) => `<str len=${[...s].length} chars=${charClass(s)}>`;

  // Redact an object KEY (review finding 1.9). Real schema key names are
  // always plain identifiers, so they pass straight through; anything else
  // might be carrying an address (routed through the same pseudonym map
  // values use, for identity consistency) or a display name / anything
  // else (routed to an opaque, collision-proof per-key pseudonym).
  const redactKey = (k) => {
    if (SAFE_KEY_PATTERN.test(k)) return k;
    const scrubbed = scrubText(k);
    if (scrubbed !== k) return scrubbed;
    return pseudoGenericKey(k);
  };

  const nearestNonNumericAncestor = (keyPath) =>
    [...keyPath].slice(0, -1).reverse().find((p) => !isNumericSegment(p));

  const redactStringValue = (s, key, keyPath) => {
    const keyLower = key?.toLowerCase();
    const parentLower = nearestNonNumericAncestor(keyPath)?.toLowerCase();
    // True when this leaf sits directly as an array element (no
    // intervening named object key) - i.e. the bare-string-array shape,
    // as opposed to a named field inside an object nested in that array.
    const isBareArrayElement = key !== undefined && isNumericSegment(key);

    // 1. Structural, identity-preserving rules - case-insensitive (review
    // finding 1.5: every one of these used to be an exact-case `===`).
    if (keyLower === "subject") return describeSubject(s);

    if (
      keyLower === "accountname" ||
      (keyLower === "name" && parentLower === "accounts") ||
      (isBareArrayElement && ACCOUNT_ARRAY_KEYS.has(parentLower))
    ) {
      return pseudoAccount(s);
    }

    if (
      (keyLower === "name" && FOLDER_KEYS.has(parentLower)) ||
      (isBareArrayElement && FOLDER_KEYS.has(parentLower))
    ) {
      return pseudoFolder(s);
    }

    if (keyLower === "path" || keyLower === "fullpath") {
      return s.split("/").map((seg) => pseudoFolder(seg)).join("/");
    }

    // 2. Standard mailbox names are not personal data, regardless of key.
    if (STANDARD_MAILBOXES.has(s)) return s;

    // 3. Content-based identity match (email address, or display+address),
    // independent of key - this is what keeps test 1 ("mail me at
    // real.person@company.com ok" -> "mail me at user1@example.com ok")
    // working: surrounding boilerplate text around a recognized pattern
    // is preserved, only the matched identity is replaced.
    const scrubbed = scrubText(s);
    if (scrubbed !== s) return scrubbed;

    // 4. A narrow, explicit allowlist of structural/enum-like value
    // fields, gated on both the key name and a conservative content
    // pattern (no "@", no path separator, short).
    if (keyLower !== undefined && VERBATIM_KEYS.has(keyLower) && SAFE_VALUE_PATTERN.test(s)) {
      return s;
    }

    // 5. Fail closed: nothing above recognized this string as safe or as
    // a known identity field, so it does not survive as text.
    return describeGeneric(s);
  };

  const walk = (value, keyPath) => {
    const key = keyPath.at(-1);

    // Keep a live Date instance intact (review finding 1.12) - it is
    // typeof "object" but Object.entries() yields no own enumerable
    // properties for it, so without this check it fell into the generic
    // object branch and was silently replaced with `{}`.
    if (value instanceof Date) return new Date(value.getTime());

    if (Array.isArray(value)) return value.map((v, i) => walk(v, [...keyPath, String(i)]));

    if (value && typeof value === "object") {
      const out = {};
      const usedKeys = new Set();
      for (const [k, v] of Object.entries(value)) {
        const redactedKey = redactKey(k);
        // Guarantee the key SET SIZE survives even under adversarial
        // collisions (review finding 1.13, `__proto__`, plus any
        // redaction-induced collision): never let two distinct original
        // keys collapse onto the same output key.
        let candidate = redactedKey;
        let n = 2;
        while (usedKeys.has(candidate)) candidate = `${redactedKey}__${n++}`;
        usedKeys.add(candidate);
        // Object.defineProperty bypasses Object.prototype's inherited
        // __proto__ accessor setter, which a plain `out[k] = v` assignment
        // would silently no-op through for a key literally named
        // "__proto__" (review finding 1.13), dropping both key and value.
        Object.defineProperty(out, candidate, {
          value: walk(v, [...keyPath, k]),
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
      return out;
    }

    if (typeof value !== "string") return value;

    return redactStringValue(value, key, keyPath);
  };

  return (value) => walk(value, []);
}

export const redact = (value) => newRedactor()(value);
