// Exported (fix round 1, task-5-review): research/record.mjs reuses this
// exact set to decide whether a probe ARGUMENT is provably non-personal and
// can be stored verbatim - see the comment on requireStorableArgs() there
// for why a duplicate copy would be the wrong fix (two sets that can drift
// apart is worse than one imported set).
export const STANDARD_MAILBOXES = new Set([
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
  // 08-gmail-inbox: names of mailboxes that contain other mailboxes. Same
  // mailbox-name context as the rest of this set - a standard name (the
  // "[Gmail]" signal the probe exists to detect) survives, others pseudonymize.
  "containernames",
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
// Fix round 4 (task-2-rereview-2.md, Critical): `accountType` used to be
// validated by the shape pattern /^[a-z]{1,12}$/, which admits any short
// lowercase word - so "jane", "roe" and "janedoe" survived VERBATIM under an
// `accountType` key. That is precisely the content-blind-pattern failure
// family this whole table replaced, just relocated to one key. It is now an
// explicit enumeration of the account types Mail actually reports (every
// account on the development machine reports `imap`; Mail's scripting
// dictionary also defines POP, SMTP and iCloud account classes, and newer
// versions report Exchange), matched case-insensitively on the VALUE so
// `IMAP`/`iCloud` survive with their original casing intact.
// The failure direction is deliberately safe: a real account reporting a
// type not listed here becomes an opaque descriptor, so the archive loses
// one word of detail and nothing breaks - whereas a shape check silently
// publishes a surname. That asymmetry is why this must stay an enum: widen
// it by ADDING the exact literal Mail reported, never by loosening it back
// into a pattern.
const ACCOUNT_TYPE_NAMES = new Set([
  "imap", "pop", "smtp", "icloud", "exchange", "unknown",
]);
// Fix round 4 (task-2-rereview-2.md, Minor): `probe` used to be
// /^[0-9]{2}-[a-z0-9-]+$/, which admits arbitrary lowercase-hyphen text
// after an NN- prefix ("20-jane-roe-notes" survived verbatim). The field
// only ever holds the basename of one of the project's 12 fixed probe
// files, enumerated in
// docs/superpowers/plans/2026-08-11-apple-mail-knowledge-archive.md as
// research/probes/NN-name.js, so it is a finite literal set. Matched
// exactly (these are lowercase filenames, not free text). Adding a 13th
// probe therefore requires adding its name here - the same intentional
// friction STRUCTURAL_KEY_NAMES already imposes on new probe FIELDS, with
// the same safe failure direction (an unlisted probe name records as an
// opaque descriptor rather than leaking whatever else lands in this field).
const PROBE_NAMES = new Set([
  "00-hello", "01-argv-modes", "02-accounts", "03-mailboxes",
  "04-message-props", "05-bulk-fetch", "06-whose-vs-bulk", "07-coldstart",
  "08-gmail-inbox", "09-unicode-dates", "10-attachment-source", "11-errors",
  // 13th probe file (added Task 4, fix round 1): measures the message-size
  // distribution instead of asserting it, per the review's Critical finding.
  "12-message-sizes",
]);
const VALUE_VALIDATORS = new Map([
  ["probe", (s) => PROBE_NAMES.has(s)],
  ["mode", (s) => s === "file" || s === "-e"],
  ["chars", (s) => s === "ascii" || s === "unicode"],
  ["accounttype", (s) => ACCOUNT_TYPE_NAMES.has(s.toLowerCase())],
  ["type", isJsTypeName],
  ["idtype", isJsTypeName],
  ["sampleidtype", isJsTypeName],
  ["dategettimetype", isJsTypeName],
  ["firstidtype", isJsTypeName],
]);
// Booleans and numbers are not strings, so they already pass through
// walk()'s primitive branch untouched - `ok`, `found`, `raised`, `status`,
// counts and timings need no entry here at all.

// Fix round 3 (see task-2-report.md "Fix round 3"): object keys in probe
// output are LITERALS WRITTEN BY THE PROBE AUTHOR in the probe source -
// they are not data returned by Mail. An unrecognized key is therefore
// almost never personal data; it is far more likely a legitimate
// structural field this allowlist has not been told about yet. Round 2's
// SAFE_KEY_PATTERN let a personal string written without spaces (e.g.
// "JaneRoePersonalNotes") survive verbatim, and its replacement silently
// RENAMED every other unrecognized key to "redactedKeyN" - which is worse:
// fingerprints exist to diff key sets, so a renamed key makes the
// fingerprint meaningless (a real Mail.app change and a redaction-induced
// rename become indistinguishable), and any later code that reads a
// field by name (e.g. a measurements generator reading `data.messageCount`)
// silently sees nothing. So this set must be COMPLETE for every key the
// project's probes actually emit, covering: this file's own structural
// rule vocabulary; the VALUE_VALIDATORS keys above; the recorder's own
// added keys (research/record.mjs: probe, args, seconds, shape, data) and
// the harness result keys (research/harness.mjs: ok, error, status); and
// every key emitted by all 12 probes named in
// docs/superpowers/plans/2026-08-11-apple-mail-knowledge-archive.md
// (Tasks 1, 4, 5, 6, 8, 9, 13), most of which are not written yet.
// Growing a probe with a new field REQUIRES adding its key here - this is
// intentional friction: it is what turns "a probe author added a field"
// into a loud failure at record time instead of a silently mangled
// fingerprint discovered much later. See redactKey() below for what
// happens to a key that is NOT here and is not purely numeric.
const STRUCTURAL_KEY_NAMES = new Set([
  // This file's own rule vocabulary
  "subject", "name", "path", "fullpath", "accountname",
  "mailboxes", "boxes", "accounts", "children",
  "mailboxnames", "foldernames", "boxnames", "accountnames",
  // The per-key value-validator table above
  "probe", "mode", "chars", "accounttype",
  "type", "idtype", "sampleidtype", "dategettimetype", "firstidtype",
  // research/harness.mjs's wrapper shape (Task 1)
  "ok", "seconds", "data", "error", "status",
  // research/record.mjs's added keys (Task 3)
  "args", "shape",
  // research/probes/00-hello.js (Task 1)
  "mailreachable", "accountcount", "argvecho",
  // research/probes/01-argv-modes.js (Task 1)
  "rawargv", "rawargvlength", "firstisseparator",
  // research/probes/07-coldstart.js (Task 4)
  "inprocessroundtrips",
  // research/probes/02-accounts.js (Task 5)
  "enabled", "emailaddresses", "username", "servername", "mailboxcount", "value",
  // research/probes/03-mailboxes.js (Task 5)
  "depth", "messagecount", "unreadcount",
  // research/probes/04-message-props.js (Task 5)
  "props", "id", "messageid", "sender", "datereceived", "datesent",
  "readstatus", "flaggedstatus", "flagindex", "messagesize", "mailboxname",
  "replyto", "torecipients", "ccrecipients", "contentlength", "sourcelength",
  "attachmentcount", "sample",
  // research/probes/05-bulk-fetch.js (Task 6)
  "fetch", "fetchtotal", "jsfilterseconds", "hits", "arraylengths", "datesample",
  // research/probes/06-whose-vs-bulk.js (Task 6)
  "whosecountseconds", "whosecount", "whosefetchseconds", "whosematched",
  "bulkseconds", "bulkhits",
  // research/probes/10-attachment-source.js (Task 8)
  "found", "scanned", "objects", "mimetype", "filesize", "downloaded",
  "objectseconds", "sourcebytes", "sourceseconds", "mime", "boundaries",
  "dispositions", "filenames", "encodedwords",
  // research/probes/08-gmail-inbox.js (Task 9)
  "totalmailboxes", "isgmailstyle", "literalinbox", "allmail", "important",
  "flatlookupinbox", "flatlookupallmail", "containernames",
  "maxdepth", "nestedcount",
  // research/probes/09-unicode-dates.js (Task 9)
  "sampled", "nonasciisubjects", "astralsubjects", "emptysubjects",
  "longestsubjectchars", "dateisdateobject", "dateisoroundtrip",
  // research/probes/11-errors.js (Task 13)
  "badaccount", "badmailbox", "badmessageindex", "badproperty", "raised", "number",
  // research/probes/12-message-sizes.js (Task 4, fix round 1) - measures the
  // message-size distribution the section-4 Critical finding required
  "fetchok", "fetcherror", "maxsizebytes", "mediansizebytes",
  "over1mb", "over4mb", "over16mb", "over64mb",
]);

const isNumericSegment = (s) => /^\d+$/.test(s);
// Used only to decide, for a key NOT on the allowlist above and not purely
// numeric, whether it looks like it could be carrying data (fails this
// test: contains "@", a space, a "/", or anything else a JS identifier
// cannot contain) versus looks like a plain structural field name the
// allowlist simply has not been told about yet (passes this test).
const JS_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Renders a location for the throw message below. Fix round 4
// (task-2-rereview-2.md, a real leak): this is ONLY ever handed ALREADY-
// REDACTED path segments (see `safePath` in walk()). It used to be given the
// raw, pre-redaction keyPath, so `{"Jane Roe": {unknownField: 1}}` threw an
// Error whose message contained "Jane Roe" verbatim, and an email-shaped
// ancestor key leaked the whole address - data that the normal output path
// correctly pseudonymizes. Error messages get logged, pasted into reports
// and committed, so the throw path is held to the same standard as the
// output path.
const describeKeyPath = (safePath) => {
  let out = "";
  for (const seg of safePath) {
    out += isNumericSegment(seg) ? `[${seg}]` : out ? `.${seg}` : seg;
  }
  return out || "(root)";
};

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

  // Redact an object KEY (review finding 1.9; fail-loudly behavior is
  // fix round 3 - see the comment on STRUCTURAL_KEY_NAMES above). A purely
  // numeric key or a name from the explicit structural allowlist is
  // schema, not data, and survives untouched. For anything else, decide
  // by shape: a key that cannot be a JS identifier (contains "@", a
  // space, a "/", ...) looks like it is carrying data, so it is
  // pseudonymized the same way the identical string would be pseudonymized
  // as a value - a probe emitting `{"someone@example.com": {...}}` must
  // redact, not throw. A key that IS identifier-shaped but simply is not
  // on the allowlist is, per the insight driving this fix, far more
  // likely a legitimate structural field nobody told this file about yet
  // than it is personal data - silently renaming it would hide that
  // mistake behind a fingerprint that still "looks" fine. So it throws,
  // loudly, naming the key and its exact path, so record.mjs surfaces it
  // as a probe failure at record time instead of a mangled recording
  // discovered later.
  // `safePath` is the ancestor path with every segment ALREADY REDACTED (a
  // pseudonym for a data-shaped ancestor key, the real text only for a
  // structural or numeric one) - fix round 4, so the thrown message cannot
  // leak an ancestor key the output path protects. The offending key itself
  // is still named: it only reaches the throw when it is identifier-shaped
  // (a data-shaped key returns above, pseudonymized, never throwing), and
  // naming an unrecognized structural field is the entire point of this
  // friction.
  const redactKey = (k, safePath) => {
    if (isNumericSegment(k)) return k;
    if (STRUCTURAL_KEY_NAMES.has(k.toLowerCase())) return k;

    if (!JS_IDENTIFIER_RE.test(k)) {
      const scrubbed = scrubText(k);
      if (scrubbed !== k) return scrubbed;
      return pseudoGenericKey(k);
    }

    throw new Error(
      `redact(): unrecognized object key "${k}" at ${describeKeyPath([...safePath, k])}. ` +
        `This key is identifier-shaped, so it is almost certainly a structural field a ` +
        `probe emits, not personal data - add "${k.toLowerCase()}" to STRUCTURAL_KEY_NAMES ` +
        `in research/redact.mjs. If it can actually hold personal data, restructure the ` +
        `probe so that data never becomes a JSON object key.`
    );
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

  // `keyPath` holds the RAW key names and drives the key-context rules
  // (a `name` under `mailboxes` must be matched by its real key text).
  // `safePath` mirrors it with every segment already redacted and is used
  // for nothing but the throw message in redactKey - fix round 4, see
  // describeKeyPath above. The two arrays always have the same length.
  const walk = (value, keyPath, safePath) => {
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
          return value.map((v, i) => walk(v, [...keyPath, String(i)], [...safePath, String(i)]));
        }
        const out = {};
        const usedKeys = new Set();
        for (const [k, v] of Object.entries(value)) {
          const redactedKey = redactKey(k, safePath);
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
            value: walk(v, [...keyPath, k], [...safePath, candidate]),
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

  return (value) => walk(value, [], []);
}

export const redact = (value) => newRedactor()(value);
