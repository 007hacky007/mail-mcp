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

// Fix-round-2 (task-2-rereview.md Hole A, Critical): a generic
// VERBATIM_KEYS + character-class-and-length pattern let "Jane Roe",
// "+1 555-123-4567" and account-number-shaped strings straight through
// under keys like `type`/`status`/`mode` - the same allowlist-plus-
// permissive-fallback failure the fail-closed inversion was meant to kill,
// just one layer down. Replaced with PER-KEY VALIDATORS: a string is kept
// verbatim only when its (lowercased) key has an entry below AND the value
// itself satisfies that key's specific check - never a generic pattern,
// never a length heuristic. If a later probe needs a new verbatim string
// field, the correct move is to add a validator for that exact key here,
// not to widen an existing one or add a generic fallback.
const JS_TYPE_NAMES = new Set([
  "number", "string", "boolean", "object", "undefined", "array", "function", "bigint", "symbol",
]);
const isJsTypeName = (s) => JS_TYPE_NAMES.has(s);
const VALUE_VALIDATORS = new Map([
  ["probe", (s) => /^[0-9]{2}-[a-z0-9-]+$/.test(s)],
  ["mode", (s) => s === "file" || s === "-e"],
  ["chars", (s) => s === "ascii" || s === "unicode"],
  ["accounttype", (s) => /^[a-z]{1,12}$/.test(s)],
  ["type", isJsTypeName],
  ["idtype", isJsTypeName],
  ["sampleidtype", isJsTypeName],
  ["dategettimetype", isJsTypeName],
  ["firstidtype", isJsTypeName],
]);
// Booleans and numbers are not strings, so they already pass through
// walk()'s primitive branch untouched - `ok`, `found`, `raised`, `status`,
// counts and timings need no entry here at all.

// Fix-round-2 (task-2-rereview.md Hole C, Part 3): SAFE_KEY_PATTERN (any
// identifier-shaped string) let a personal string written without spaces
// - e.g. "JaneRoePersonalNotes" - survive as an object key untouched, and
// separately mis-redacted purely-numeric keys like "0"/"1" into
// "redactedKeyN" even though a numeric key cannot itself be personal data
// (breaking exact key-set preservation, which Task 3's structural-
// fingerprint diffing depends on). Replaced with two narrow, explicit
// checks in redactKey below: a key is kept verbatim only if it is purely
// numeric, or it is one of the following known structural key names -
// this file's own rule vocabulary, the VALUE_VALIDATORS keys above, and
// the real field names research/harness.mjs and the two probes written so
// far (00-hello.js, 01-argv-modes.js) actually emit. Extend this set, not
// a pattern, when a new probe introduces a genuinely new structural field.
const STRUCTURAL_KEY_NAMES = new Set([
  // This file's own rule vocabulary
  "subject", "name", "path", "fullpath", "accountname",
  "mailboxes", "boxes", "accounts", "children",
  "mailboxnames", "foldernames", "boxnames", "accountnames",
  // The per-key value-validator table above
  "probe", "mode", "chars", "accounttype",
  "type", "idtype", "sampleidtype", "dategettimetype", "firstidtype",
  // research/harness.mjs's own wrapper shape
  "ok", "seconds", "data", "error", "status",
  // research/probes/00-hello.js
  "mailreachable", "accountcount", "argvecho",
  // research/probes/01-argv-modes.js
  "rawargv", "rawargvlength", "firstisseparator",
]);

const isNumericSegment = (s) => /^\d+$/.test(s);

export function newRedactor() {
  const emails = new Map();
  const people = new Map();
  const accounts = new Map();
  const folders = new Map();
  const genericKeys = new Map();
  // Tracks the object/array references currently on the recursion path,
  // so a truly cyclic input (an object that is its own ancestor) fails
  // with a clear error instead of a bare "Maximum call stack size
  // exceeded" RangeError (task-2-rereview.md, cyclic-input note). A
  // non-cyclic shared reference (the same object reachable via two
  // sibling, non-nested paths - not itself a cycle) is fine: it is added
  // on entry and removed once that branch finishes, so revisiting it from
  // a later, unrelated branch does not falsely trigger this check.
  const seen = new Set();

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

  // Redact an object KEY (review finding 1.9). A purely-numeric key
  // (Fix 2) or a name from the explicit structural allowlist (Fix 4) is
  // schema, not data, and survives untouched; anything else might be
  // carrying an address (routed through the same pseudonym map values
  // use, for identity consistency) or a display name / anything else
  // (routed to an opaque, collision-proof per-key pseudonym).
  const redactKey = (k) => {
    if (isNumericSegment(k)) return k;
    if (STRUCTURAL_KEY_NAMES.has(k.toLowerCase())) return k;
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
    // pseudoFolder() internally keeps a standard mailbox name verbatim;
    // that passthrough is only reachable via these folder-context rules
    // (fix-round-2 Hole B: it used to also run unconditionally on every
    // string anywhere, which let an unrelated free-text field that
    // happened to read exactly "Important" or "Archive" survive too).
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

    // 2. Content-based identity match (email address, or display+address),
    // independent of key - this is what keeps test 1 ("mail me at
    // real.person@company.com ok" -> "mail me at user1@example.com ok")
    // working: surrounding boilerplate text around a recognized pattern
    // is preserved, only the matched identity is replaced.
    const scrubbed = scrubText(s);
    if (scrubbed !== s) return scrubbed;

    // 3. Per-key value validators (Fix 1) - the only remaining escape
    // hatch, and it is narrow and semantic per key, not a generic pattern.
    const validator = keyLower !== undefined ? VALUE_VALIDATORS.get(keyLower) : undefined;
    if (validator && validator(s)) return s;

    // 4. Fail closed: nothing above recognized this string as safe or as
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

    if (value && typeof value === "object") {
      if (seen.has(value)) {
        throw new Error("redact(): cyclic reference detected; refusing to redact a circular structure");
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          return value.map((v, i) => walk(v, [...keyPath, String(i)]));
        }
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
          // __proto__ accessor setter, which a plain `out[k] = v`
          // assignment would silently no-op through for a key literally
          // named "__proto__" (review finding 1.13), dropping both key
          // and value.
          Object.defineProperty(out, candidate, {
            value: walk(v, [...keyPath, k]),
            writable: true,
            enumerable: true,
            configurable: true,
          });
        }
        return out;
      } finally {
        seen.delete(value);
      }
    }

    if (typeof value !== "string") return value;

    return redactStringValue(value, key, keyPath);
  };

  return (value) => walk(value, []);
}

export const redact = (value) => newRedactor()(value);
