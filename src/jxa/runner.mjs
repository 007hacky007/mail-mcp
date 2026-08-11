/**
 * Runs JXA scripts against Mail.app.
 *
 * Every rule here is load-bearing and traces to a measured finding in
 * docs/apple-mail/01-execution-model.md. Read that before changing anything.
 */
import { spawn } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Mail message sources reach 26.7 MB on real mailboxes (138 messages over 1 MB
 * out of 17,486 measured), so Node's 1 MB default would fail on exactly the
 * messages that matter. Nothing measured exceeded 64 MB.
 */
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/** Default per-call ceiling. Bulk fetches over a large mailbox take tens of seconds. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Mail.app's AppleScript dispatch is single-threaded: concurrent calls do not
 * overlap, they each pay full cost while holding the queue. So we serialize in
 * process and charge queue wait against the caller's deadline, which lets a
 * request that waited out its own budget say so instead of timing out opaquely.
 */
let tail = Promise.resolve();

export class JxaError extends Error {
  constructor(message, { kind, stderr, status, signal }) {
    super(message);
    this.name = "JxaError";
    this.kind = kind; // "transport" | "timeout" | "domain"
    this.stderr = stderr;
    this.status = status;
    this.signal = signal;
  }
}

function classify({ status, signal, stderr, stdout, timedOut }) {
  if (timedOut) {
    return new JxaError(
      `Mail.app did not answer within the deadline. It may be unresponsive, or the ` +
        `mailbox is large enough that this operation cannot complete.`,
      { kind: "timeout", stderr, status, signal }
    );
  }
  const text = (stderr || "").trim();
  if (/not authorized|not permitted|access.*denied/i.test(text)) {
    return new JxaError(
      "Permission denied. Grant Automation access to Mail.app in System Settings > " +
        "Privacy & Security > Automation, then try again.",
      { kind: "transport", stderr, status, signal }
    );
  }
  if (/application isn't running|Application can't be found/i.test(text)) {
    return new JxaError("Mail.app is not running. Open Mail.app and try again.", {
      kind: "transport",
      stderr,
      status,
      signal,
    });
  }
  // -1728 is Mail's "Can't get object", and it names no object, so it cannot be
  // turned into a useful message here. Callers must validate names against
  // enumerated lists BEFORE calling, so this stays a genuine internal error.
  return new JxaError(
    text ? `Mail.app scripting failed: ${text}` : `osascript exited ${status} with no diagnostic.`,
    { kind: "transport", stderr, status, signal }
  );
}

function spawnOnce(scriptPath, args, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    // No shell. argv array only: a mailbox name containing a quote or a
    // backslash must never be able to become code. Verified that quotes,
    // backslashes and spaces survive intact.
    const child = spawn("osascript", ["-l", "JavaScript", scriptPath, "--", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let timedOut = false;
    let overflowed = false;

    const timer = setTimeout(() => {
      timedOut = true;
      // SIGKILL, not SIGTERM: a wedged osascript blocked on an unresponsive
      // Mail.app ignores SIGTERM and piles up, worsening the contention.
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BUFFER_BYTES) {
        overflowed = true;
        child.kill("SIGKILL");
        return;
      }
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectPromise(
        new JxaError(`Could not launch osascript: ${err.message}`, {
          kind: "transport",
          stderr,
        })
      );
    });

    child.on("close", (status, signal) => {
      clearTimeout(timer);
      if (overflowed) {
        rejectPromise(
          new JxaError(
            `Mail.app returned more than ${MAX_BUFFER_BYTES} bytes. Narrow the request.`,
            { kind: "transport", stderr, status, signal }
          )
        );
        return;
      }
      if (timedOut || status !== 0) {
        rejectPromise(classify({ status, signal, stderr, stdout, timedOut }));
        return;
      }
      try {
        resolvePromise(JSON.parse(stdout));
      } catch {
        // Non-JSON stdout is a bug, never a value to parse leniently, and
        // never an empty result. A failed read must not look like "found nothing".
        rejectPromise(
          new JxaError(
            `Script did not return JSON. First 200 characters: ${stdout.slice(0, 200)}`,
            { kind: "transport", stderr, status, signal }
          )
        );
      }
    });
  });
}

/**
 * Run a JXA script, serialized behind any other in-flight Mail call.
 *
 * @param {string} name    script basename in src/jxa, without .js
 * @param {string[]} args  values, passed as argv and never interpolated
 * @param {{timeoutMs?: number, deadlineAt?: number}} opts
 */
export function runJxa(name, args = [], opts = {}) {
  const scriptPath = resolve(HERE, `${name}.js`);
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const requestedAt = Date.now();

  const run = async () => {
    const queueWaitMs = Date.now() - requestedAt;
    // Charge queue wait against the caller's budget rather than silently
    // spending it, so an overloaded server blames the queue and not Mail.
    const remaining = timeoutMs - queueWaitMs;
    if (remaining <= 0) {
      throw new JxaError(
        `Waited ${queueWaitMs}ms behind other Mail requests and ran out of budget ` +
          `before starting. Mail calls cannot overlap; issue them one at a time.`,
        { kind: "timeout" }
      );
    }
    const value = await spawnOnce(scriptPath, args, remaining);
    return { value, queueWaitMs };
  };

  // Chain regardless of whether the previous call succeeded.
  const result = tail.then(run, run);
  tail = result.then(
    () => undefined,
    () => undefined
  );
  return result;
}

/**
 * The first Apple Event after Mail.app's process starts is dramatically slower
 * than later ones. Pay it at startup rather than inside a user's first request.
 * Failure is ignored: if Mail is not running yet, the real call will report it.
 */
export async function warmUp() {
  try {
    await runJxa("probe", [], { timeoutMs: 20_000 });
  } catch {
    // Intentionally silent, see above.
  }
}
