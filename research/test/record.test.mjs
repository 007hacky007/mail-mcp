import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFileSync, rmSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PROBE_DIR } from "../harness.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const RECORD_MJS = resolve(HERE, "..", "record.mjs");
const RESULTS_DIR = resolve(HERE, "..", "results");

// research/redact.mjs deliberately throws when a probe's JSON output contains
// an object key it does not recognize (see STRUCTURAL_KEY_NAMES there): the
// point is to force the probe author to declare the field instead of
// silently getting a mangled fingerprint. record.mjs must catch that throw
// and fail cleanly - not crash with a stack trace, not write a partial or
// unredacted recording. Exercised end to end via a throwaway fixture probe
// (never one of the project's 12 real numbered probes) that emits an
// undeclared key and touches Mail.app not at all.
test("record.mjs fails cleanly, naming the probe and the undeclared key, and writes nothing", () => {
  const fixtureName = "__test-fixture-undeclared-key";
  const fixturePath = resolve(PROBE_DIR, `${fixtureName}.js`);
  const resultPath = resolve(RESULTS_DIR, `${fixtureName}.json`);

  writeFileSync(
    fixturePath,
    'function run(argv) { return JSON.stringify({ notOnAllowlist: 42 }); }\n'
  );

  try {
    const proc = spawnSync(process.execPath, [RECORD_MJS, fixtureName], {
      encoding: "utf8",
    });

    assert.equal(proc.status, 1, `expected exit 1, got ${proc.status}; stderr:\n${proc.stderr}`);
    assert.match(proc.stderr, new RegExp(fixtureName));
    assert.match(proc.stderr, /notOnAllowlist/);
    assert.match(proc.stderr, /STRUCTURAL_KEY_NAMES/);
    // No stack trace: the throw was caught, not left to bubble up.
    assert.doesNotMatch(proc.stderr, /at file:\/\//);
    assert.equal(existsSync(resultPath), false, "no recording - partial or otherwise - must be written");
  } finally {
    rmSync(fixturePath, { force: true });
    rmSync(resultPath, { force: true });
  }
});
