import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// The core security decisions, enforced as failing tests rather than stated
// intent (design spec 8.1): no code path can transmit mail, no module opens
// a network socket, no shell is ever spawned, and the package ships zero
// runtime dependencies. If any of these starts failing, someone is changing
// a decision, not fixing a bug.

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const ENTRY = resolve(ROOT, "src", "index.mjs");

// Only these builtins are legitimate in the server tree. An allowlist beats
// a banlist: a new import of anything else must be justified here first.
const ALLOWED_BUILTINS = new Set([
  "node:child_process",
  "node:fs",
  "node:os",
  "node:path",
  "node:readline",
  "node:url",
]);

function importsOf(source) {
  const found = [];
  const staticRe = /import\s+(?:[^"'()]*?from\s+)?["']([^"']+)["']/g;
  const dynamicRe = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  const requireRe = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
  for (const re of [staticRe, dynamicRe, requireRe]) {
    let m;
    while ((m = re.exec(source)) !== null) found.push(m[1]);
  }
  return found;
}

/** Every module reachable from the entry point, as {path: source}. */
function dependencyClosure(entry) {
  const seen = new Map();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.pop();
    if (seen.has(path)) continue;
    const source = readFileSync(path, "utf8");
    seen.set(path, source);
    for (const spec of importsOf(source)) {
      if (spec.startsWith(".")) queue.push(resolve(dirname(path), spec));
    }
  }
  return seen;
}

test("import scanner sees static, dynamic and require forms", () => {
  const src = `
    import a from "node:net";
    import { b } from "./x.mjs";
    const c = await import("node:tls");
    const d = require("node:http");
  `;
  assert.deepEqual(importsOf(src), ["node:net", "./x.mjs", "node:tls", "node:http"]);
});

test("no module in the server closure imports outside the builtin allowlist", () => {
  const closure = dependencyClosure(ENTRY);
  assert.ok(closure.size >= 15, `closure suspiciously small: ${closure.size} modules`);
  for (const [path, source] of closure) {
    for (const spec of importsOf(source)) {
      if (spec.startsWith(".")) continue;
      assert.ok(
        ALLOWED_BUILTINS.has(spec),
        `${path} imports "${spec}", which is not on the allowlist. ` +
          `node:net/tls/http/https/dgram and any package dependency are forbidden by design.`
      );
    }
  }
});

test("no module in the server closure references network globals", () => {
  for (const [path, source] of dependencyClosure(ENTRY)) {
    assert.ok(!/\bfetch\s*\(/.test(source), `${path} calls fetch()`);
    assert.ok(!/\bWebSocket\b/.test(source), `${path} references WebSocket`);
    assert.ok(!/\bXMLHttpRequest\b/.test(source), `${path} references XMLHttpRequest`);
  }
});

test("no shell: only spawn may come from child_process, and never with shell:true", () => {
  for (const [path, source] of dependencyClosure(ENTRY)) {
    // node:child_process is the only road to a shell, so pinning what may be
    // imported from it is precise where a bare /exec(/ grep is not (regex
    // .exec() is fine and used by the MIME parser).
    const cpImport = source.match(/import\s*\{([^}]*)\}\s*from\s*["']node:child_process["']/);
    if (cpImport) {
      const names = cpImport[1].split(",").map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      for (const name of names) {
        assert.equal(name, "spawn", `${path} imports ${name} from child_process; only spawn is allowed`);
      }
    }
    assert.ok(!/\bexecSync\s*\(/.test(source), `${path} uses execSync`);
    assert.ok(!/shell\s*:\s*true/.test(source), `${path} spawns with shell:true`);
  }
});

test("no JXA script can send mail or reach the network", () => {
  const jxaDir = resolve(ROOT, "src", "jxa");
  const scripts = readdirSync(jxaDir).filter((f) => f.endsWith(".js"));
  assert.ok(scripts.length >= 10, `expected the full script set, found ${scripts.length}`);
  for (const file of scripts) {
    const source = readFileSync(resolve(jxaDir, file), "utf8");
    // .send( or send( would be Mail's send verb: the one call that must
    // never exist. "sends"/"sent" in comments do not match.
    assert.ok(!/\bsend\s*\(/.test(source), `src/jxa/${file} contains a send() call`);
    assert.ok(!/doShellScript/i.test(source), `src/jxa/${file} runs a shell`);
    assert.ok(!/ObjC\.import/.test(source), `src/jxa/${file} imports ObjC frameworks`);
    assert.ok(!/NSURL|NSTask|NSData/.test(source), `src/jxa/${file} touches Cocoa network/process APIs`);
  }
});

test("package.json declares zero runtime dependencies, ever", () => {
  const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
  assert.ok(!("dependencies" in pkg), "package.json must never grow a dependencies key");
  assert.ok(!("optionalDependencies" in pkg), "no optionalDependencies either");
  assert.ok(!("peerDependencies" in pkg), "no peerDependencies either");
});

test("the tool surface has no send, delete or move capability", () => {
  const source = readFileSync(resolve(ROOT, "src", "tools", "index.mjs"), "utf8");
  const closure = dependencyClosure(ENTRY);
  for (const [path] of closure) {
    const base = path.split("/").pop();
    assert.ok(!/^(send|delete|move)/.test(base), `suspicious tool module: ${base}`);
  }
  assert.ok(!/send-mail|sendMessage/i.test(source), "registry mentions sending");
});
