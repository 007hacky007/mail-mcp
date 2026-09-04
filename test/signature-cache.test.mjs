import { test } from "node:test";
import assert from "node:assert/strict";
import { createSignatureCache } from "../src/mail/signature-cache.mjs";

// Signature HTML harvested from a saved draft is remembered for the life of
// the server process so later drafts need one save instead of two.

test("signature cache remembers by name and hands out a detached snapshot", () => {
  const cache = createSignatureCache();
  assert.deepEqual(cache.snapshot(), {});
  cache.remember("Sig", "<div>s</div>");
  const snap = cache.snapshot();
  assert.deepEqual(snap, { Sig: "<div>s</div>" });
  snap.Other = "x";
  assert.deepEqual(cache.snapshot(), { Sig: "<div>s</div>" });
});

test("signature cache ignores unusable entries and lets a newer harvest replace an older one", () => {
  const cache = createSignatureCache();
  cache.remember(null, "<div>s</div>");
  cache.remember("Sig", "");
  cache.remember("Sig", 42);
  assert.deepEqual(cache.snapshot(), {});
  cache.remember("Sig", "<div>old</div>");
  cache.remember("Sig", "<div>new</div>");
  assert.deepEqual(cache.snapshot(), { Sig: "<div>new</div>" });
});
