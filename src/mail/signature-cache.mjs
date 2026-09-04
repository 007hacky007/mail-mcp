/**
 * Signature HTML harvested from saved drafts, by signature name, kept for the
 * life of the server process. The respond-draft script needs two saves to
 * harvest a signature (docs/apple-mail/README.md, draft recipes); with a
 * cached copy it needs one. Nothing is written to disk: a signature is the
 * user's own data, but it does not need to outlive the process.
 */
export function createSignatureCache() {
  const map = new Map();
  return {
    /** A detached {name: html} copy, safe to serialize into argv. */
    snapshot: () => Object.fromEntries(map),
    remember: (name, html) => {
      if (typeof name !== "string" || name.length === 0) return;
      if (typeof html !== "string" || html.length === 0) return;
      map.set(name, html);
    },
  };
}

export const signatureCache = createSignatureCache();
