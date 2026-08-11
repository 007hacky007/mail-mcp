import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sanitizeFilename, resolveSaveTarget } from "../src/mail/save-path.mjs";

// Attachment filenames come from mail, which is attacker-controlled input.
// These are the tests that make invariant 9 (writes confined to the
// allowlisted root) a property of the code rather than an intention.

test("sanitizeFilename strips directory traversal to a bare basename", () => {
  assert.equal(sanitizeFilename("../../etc/passwd"), "passwd");
  assert.equal(sanitizeFilename("..\\..\\windows\\evil.exe"), "evil.exe");
  assert.equal(sanitizeFilename("/absolute/path/name.pdf"), "name.pdf");
});

test("sanitizeFilename removes hidden-file dots, control chars and separators", () => {
  assert.equal(sanitizeFilename(".hidden"), "hidden");
  assert.equal(sanitizeFilename("..."), null);
  assert.equal(sanitizeFilename("a b\nc.txt"), "a bc.txt");
  assert.equal(sanitizeFilename("con:trol|chars?.pdf"), "con_trol_chars_.pdf");
});

test("sanitizeFilename keeps ordinary unicode and caps length", () => {
  assert.equal(sanitizeFilename("zpráva final.pdf"), "zpráva final.pdf");
  const long = "x".repeat(300) + ".pdf";
  const out = sanitizeFilename(long);
  assert.ok(out.length <= 200);
  assert.ok(out.endsWith(".pdf"));
});

test("sanitizeFilename returns null for nothing usable", () => {
  assert.equal(sanitizeFilename(""), null);
  assert.equal(sanitizeFilename(null), null);
  assert.equal(sanitizeFilename("///"), null);
});

// resolveSaveTarget: root containment with symlinks resolved.

function makeRoot() {
  const base = mkdtempSync(join(tmpdir(), "mail-mcp-save-test-"));
  const root = join(base, "root");
  const outside = join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
  return { base, root, rootReal: realpathSync(root), outside };
}

test("default target lands in the root under the sanitized name", () => {
  const { base, root, rootReal } = makeRoot();
  try {
    const target = resolveSaveTarget({ root, filename: "../sneaky.pdf", index: 0 });
    assert.equal(target, join(rootReal, "sneaky.pdf"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit savePath must be absolute", () => {
  const { base, root } = makeRoot();
  try {
    assert.throws(() => resolveSaveTarget({ root, savePath: "relative/x.pdf", filename: "x", index: 0 }), /absolute/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("explicit savePath outside the root is refused", () => {
  const { base, root, outside } = makeRoot();
  try {
    assert.throws(
      () => resolveSaveTarget({ root, savePath: join(outside, "x.pdf"), filename: "x", index: 0 }),
      /allowlisted root/
    );
    assert.throws(
      () => resolveSaveTarget({ root, savePath: join(root, "..", "outside", "x.pdf"), filename: "x", index: 0 }),
      /allowlisted root/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a symlinked directory inside the root cannot smuggle the write outside", () => {
  const { base, root, outside } = makeRoot();
  try {
    symlinkSync(outside, join(root, "link"));
    assert.throws(
      () => resolveSaveTarget({ root, savePath: join(root, "link", "x.pdf"), filename: "x", index: 0 }),
      /allowlisted root/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a savePath into a subdirectory of the root is allowed", () => {
  const { base, root, rootReal } = makeRoot();
  try {
    mkdirSync(join(root, "sub"));
    const target = resolveSaveTarget({ root, savePath: join(root, "sub", "x.pdf"), filename: "x", index: 0 });
    assert.equal(target, join(rootReal, "sub", "x.pdf"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a savePath whose directory does not exist is refused, not created", () => {
  const { base, root } = makeRoot();
  try {
    assert.throws(
      () => resolveSaveTarget({ root, savePath: join(root, "nope", "x.pdf"), filename: "x", index: 0 }),
      /does not exist/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("an existing target is refused rather than overwritten", () => {
  const { base, root } = makeRoot();
  try {
    writeFileSync(join(root, "x.pdf"), "already here");
    assert.throws(
      () => resolveSaveTarget({ root, savePath: join(root, "x.pdf"), filename: "x", index: 0 }),
      /already exists/
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("no usable filename falls back to an indexed name", () => {
  const { base, root, rootReal } = makeRoot();
  try {
    const target = resolveSaveTarget({ root, filename: null, index: 2 });
    assert.equal(target, join(rootReal, "attachment-2"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
