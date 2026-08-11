/**
 * doctor: the first tool to reach for when anything else misbehaves.
 *
 * Reports Mail.app running state, Automation permission, account visibility,
 * Node binary signing (an ad-hoc-signed Node changes cdhash on every upgrade,
 * so TCC forgets the Automation grant), the resolved script directory, and a
 * warm round-trip timing.
 */
import { spawn } from "node:child_process";
import { readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runJxa as realRunJxa } from "../jxa/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const JXA_DIR = resolve(HERE, "..", "jxa");

/**
 * Parse `codesign -dv` output (it writes to stderr). Pure so it is testable
 * against recorded samples without spawning anything.
 */
export function classifySigning(text) {
  const authority = (text.match(/^Authority=(.+)$/m) || [])[1] ?? null;
  if (/^Signature=adhoc$/m.test(text) || /flags=0x[0-9a-f]+\(adhoc/i.test(text)) {
    return { signing: "ad-hoc", authority: null };
  }
  if (authority && authority.startsWith("Developer ID Application")) {
    return { signing: "developer-id", authority };
  }
  if (/code object is not signed at all/.test(text)) {
    return { signing: "unsigned", authority: null };
  }
  if (authority) return { signing: "signed", authority };
  return { signing: "unknown", authority: null };
}

function defaultCheckSigning() {
  return new Promise((resolvePromise) => {
    // No shell; argv array only, same rule as every other spawn in this tree.
    const child = spawn("codesign", ["-dv", process.execPath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", () => resolvePromise({ signing: "unknown", authority: null }));
    child.on("close", () => resolvePromise(classifySigning(stderr)));
  });
}

function defaultListJxaScripts() {
  const scripts = readdirSync(JXA_DIR)
    .filter((f) => f.endsWith(".js"))
    .sort();
  return { dir: JXA_DIR, scripts };
}

export function createDoctorTool(deps = {}) {
  const {
    runJxa = realRunJxa,
    checkSigning = defaultCheckSigning,
    listJxaScripts = defaultListJxaScripts,
    serverVersion = "0.0.0",
  } = deps;

  return {
    name: "doctor",
    description:
      "Diagnose the Mail MCP setup: whether Mail.app is running and reachable, " +
      "whether Automation permission is granted, how many accounts are visible, " +
      "how the Node binary is signed, and a warm round-trip timing. Run this first " +
      "when any other tool misbehaves.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const startedAt = process.hrtime.bigint();
      let probe = null;
      let probeError = null;
      let queueWaitMs = null;
      try {
        const result = await runJxa("doctor", [], { timeoutMs: 20_000 });
        probe = result.value;
        queueWaitMs = result.queueWaitMs;
      } catch (err) {
        // The doctor's whole job is diagnosing failure: a runner error becomes
        // part of the report, never a thrown tool error.
        probeError = err instanceof Error ? err.message : String(err);
      }
      const seconds = Number(process.hrtime.bigint() - startedAt) / 1e9;

      const signing = await checkSigning();
      const scripts = listJxaScripts();

      let automation = "unknown";
      let mail;
      if (probe) {
        if (probe.mailReachable) {
          automation = "granted";
        } else if (/not authorized|not permitted|-1743/i.test(probe.errorText)) {
          automation = "denied";
        }
        mail = {
          running: probe.mailRunning,
          reachable: probe.mailReachable,
          accountCount: probe.accountCount,
          enabledAccountCount: probe.enabledAccountCount,
          error:
            probe.errorText ||
            (probe.mailRunning ? null : "Mail.app is not running. Open Mail.app and try again."),
        };
      } else {
        if (/Automation access|Permission denied/i.test(probeError)) automation = "denied";
        mail = {
          running: null,
          reachable: false,
          accountCount: null,
          enabledAccountCount: null,
          error: probeError,
        };
      }

      return {
        ok: Boolean(probe && probe.mailReachable),
        mail,
        automation,
        warmRoundTrip: probe ? { seconds, queueWaitMs } : null,
        node: {
          execPath: process.execPath,
          version: process.version,
          signing: signing.signing,
          authority: signing.authority,
          note:
            signing.signing === "ad-hoc"
              ? "Ad-hoc signed Node (typical for Homebrew): its cdhash changes on every " +
                "upgrade, so macOS forgets the Automation grant and re-prompts. Prefer an " +
                "official Developer-ID-signed Node at a stable path."
              : null,
        },
        scripts,
        server: { name: "mail-mcp", version: serverVersion },
      };
    },
  };
}
