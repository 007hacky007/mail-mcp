// Runs a JXA probe and returns its parsed JSON output plus a wall-clock timing.
// No shell: spawnSync receives an argv array, so probe arguments can contain
// quotes, backslashes and spaces without any escaping layer.
import { spawnSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const PROBE_DIR = resolve(HERE, "probes");

// Mail message sources routinely exceed Node's 1MB default, which would surface
// as an opaque ENOBUFS. Upstream hit this and raised it; so do we.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

// Bulk fetches over a large mailbox legitimately take tens of seconds.
const DEFAULT_TIMEOUT_MS = 120_000;

export function runProbe(name, args = [], timeoutMs = DEFAULT_TIMEOUT_MS) {
  const script = resolve(PROBE_DIR, `${name}.js`);
  const started = process.hrtime.bigint();

  // "--" separates our arguments from osascript's own flags so a value that
  // begins with "-" is never mistaken for one. Probes strip it (see argsOf).
  const result = spawnSync(
    "osascript",
    ["-l", "JavaScript", script, "--", ...args],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      // SIGKILL, not SIGTERM: a wedged osascript blocked on an unresponsive
      // Mail.app ignores SIGTERM and piles up.
      killSignal: "SIGKILL",
      maxBuffer: MAX_BUFFER_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const seconds = Number(process.hrtime.bigint() - started) / 1e9;

  if (result.error) {
    return { ok: false, seconds, error: `spawn failed: ${result.error.message}` };
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || "").trim();
    return {
      ok: false,
      seconds,
      status: result.status,
      error: stderr || `osascript exited ${result.status} with no stderr`,
    };
  }
  try {
    return { ok: true, seconds, data: JSON.parse(result.stdout) };
  } catch {
    return {
      ok: false,
      seconds,
      error: `non-JSON stdout (first 200 chars): ${result.stdout.slice(0, 200)}`,
    };
  }
}
