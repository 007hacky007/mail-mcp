import { test } from "node:test";
import assert from "node:assert/strict";
import { classifySigning, createDoctorTool } from "../src/tools/doctor.mjs";

// Tier 1: no Mail.app, no osascript. The runner is injected so these tests
// exercise the doctor's real control flow - status classification and report
// shaping - against fixture results, which is the logic that can rot.

const FIXTURE_DEPS = {
  runJxa: async () => ({
    value: {
      mailRunning: true,
      mailReachable: true,
      accountCount: 5,
      enabledAccountCount: 2,
      errorText: "",
    },
    queueWaitMs: 0,
  }),
  checkSigning: async () => ({ signing: "developer-id", authority: "Developer ID Application: X" }),
  listJxaScripts: () => ({ dir: "/resolved/jxa", scripts: ["doctor.js", "probe.js"] }),
  serverVersion: "0.1.0",
};

test("doctor reports a healthy Mail as reachable with automation granted", async () => {
  const tool = createDoctorTool(FIXTURE_DEPS);
  const report = await tool.handler({});
  assert.equal(report.ok, true);
  assert.equal(report.mail.running, true);
  assert.equal(report.mail.reachable, true);
  assert.equal(report.mail.accountCount, 5);
  assert.equal(report.mail.enabledAccountCount, 2);
  assert.equal(report.automation, "granted");
  assert.equal(typeof report.warmRoundTrip.seconds, "number");
  assert.equal(report.warmRoundTrip.queueWaitMs, 0);
  assert.equal(report.scripts.dir, "/resolved/jxa");
  assert.deepEqual(report.scripts.scripts, ["doctor.js", "probe.js"]);
  assert.equal(report.node.signing, "developer-id");
});

test("doctor classifies a -1743 style refusal as automation denied", async () => {
  const tool = createDoctorTool({
    ...FIXTURE_DEPS,
    runJxa: async () => ({
      value: {
        mailRunning: true,
        mailReachable: false,
        accountCount: 0,
        enabledAccountCount: 0,
        errorText: "Error: Not authorized to send Apple events to Mail. (-1743)",
      },
      queueWaitMs: 0,
    }),
  });
  const report = await tool.handler({});
  assert.equal(report.ok, false);
  assert.equal(report.automation, "denied");
  assert.equal(report.mail.reachable, false);
  assert.match(report.mail.error, /Not authorized/);
});

test("doctor reports Mail not running without claiming anything about automation", async () => {
  const tool = createDoctorTool({
    ...FIXTURE_DEPS,
    runJxa: async () => ({
      value: {
        mailRunning: false,
        mailReachable: false,
        accountCount: 0,
        enabledAccountCount: 0,
        errorText: "",
      },
      queueWaitMs: 0,
    }),
  });
  const report = await tool.handler({});
  assert.equal(report.ok, false);
  assert.equal(report.mail.running, false);
  assert.equal(report.automation, "unknown");
});

// The doctor's whole job is diagnosing failure, so a transport failure from
// the runner must become part of the report, never a thrown tool error.
test("doctor folds a runner failure into the report instead of throwing", async () => {
  const tool = createDoctorTool({
    ...FIXTURE_DEPS,
    runJxa: async () => {
      const err = new Error("Mail.app did not answer within the deadline.");
      err.kind = "timeout";
      throw err;
    },
  });
  const report = await tool.handler({});
  assert.equal(report.ok, false);
  assert.equal(report.mail.reachable, false);
  assert.match(report.mail.error, /did not answer/);
  assert.equal(report.automation, "unknown");
  assert.equal(report.warmRoundTrip, null);
});

test("doctor tool declares a closed, empty-object input schema", () => {
  const tool = createDoctorTool(FIXTURE_DEPS);
  assert.equal(tool.name, "doctor");
  assert.equal(tool.inputSchema.type, "object");
  assert.equal(tool.inputSchema.additionalProperties, false);
});

// classifySigning parses `codesign -dv` stderr. Real-world samples, ASCII-cleaned.
test("classifySigning: Homebrew-style adhoc signature", () => {
  const out = [
    "Executable=/opt/homebrew/bin/node",
    "Identifier=node",
    "Format=Mach-O thin (arm64)",
    "CodeDirectory v=20400 size=... flags=0x20002(adhoc,linker-signed) hashes=...",
    "Signature=adhoc",
  ].join("\n");
  assert.equal(classifySigning(out).signing, "ad-hoc");
});

test("classifySigning: Developer ID signed node", () => {
  const out = [
    "Executable=/usr/local/bin/node",
    "Identifier=node",
    "Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)",
    "Authority=Developer ID Certification Authority",
    "Authority=Apple Root CA",
  ].join("\n");
  const result = classifySigning(out);
  assert.equal(result.signing, "developer-id");
  assert.match(result.authority, /^Developer ID Application/);
});

test("classifySigning: unsigned binary", () => {
  assert.equal(
    classifySigning("/x/node: code object is not signed at all").signing,
    "unsigned"
  );
});

test("classifySigning: unrecognized output stays unknown", () => {
  assert.equal(classifySigning("").signing, "unknown");
});
