/**
 * The three failure classes, kept distinct on purpose (design spec section 9):
 * transport failures come from the runner as JxaError; domain failures are
 * Mail answering "no" and carry the enumerated candidates so a caller can
 * retry correctly instead of guessing; partial success is not an error at all
 * and is shaped by each tool. Collapsing these is how upstream ended up
 * reporting transport failures as empty results.
 */
export class DomainError extends Error {
  constructor(message, details) {
    super(message);
    this.name = "DomainError";
    this.details = details;
  }
}

/**
 * Scripts report domain refusals structurally: { ok: false, error: { code,
 * requested?, account?, candidates? } }. This turns that into a thrown
 * DomainError whose message names the real candidates, because Mail's own
 * -1728 names nothing and cannot be recovered after the fact.
 */
export function throwDomain(error) {
  const code = error?.code ?? "unknown";
  const candidates = Array.isArray(error?.candidates) ? error.candidates : [];
  const requested = error?.requested;
  const account = error?.account;

  switch (code) {
    case "account-not-found":
      throw new DomainError(
        `No account is named ${JSON.stringify(requested ?? "")}. ` +
          `Configured accounts: ${candidates.join(", ") || "(none visible)"}.`,
        error
      );
    case "account-disabled":
      throw new DomainError(
        `Account ${JSON.stringify(account ?? "")} is disabled in Mail, so Mail holds no ` +
          `live connection to it and mailbox operations against it would fail. ` +
          `Enable it in Mail's account settings, or query another account.`,
        error
      );
    case "mailbox-not-found":
      throw new DomainError(
        `No mailbox matches the path ${JSON.stringify(requested ?? "")} in account ` +
          `${JSON.stringify(account ?? "")}. Available at that level: ` +
          `${candidates.join(", ") || "(none)"}.`,
        error
      );
    case "mailbox-too-large":
      throw new DomainError(
        `Mailbox ${JSON.stringify(requested ?? "")} in account ${JSON.stringify(account ?? "")} ` +
          `holds ${error.messageCount} messages, over the size guard of ${error.maxMessages}. ` +
          `Bulk operations degrade worse than linearly with mailbox size, so this is refused ` +
          `by default. Pass a larger maxMessages to scan it anyway (expect it to be slow), ` +
          `or narrow the scope.`,
        error
      );
    case "message-not-found":
      throw new DomainError(
        `No message with id ${error.requested} exists in mailbox ` +
          `${JSON.stringify(error.mailbox ?? "")} of account ${JSON.stringify(account ?? "")}. ` +
          `Message ids are per-mailbox and do not survive a move: an id obtained earlier may ` +
          `now belong to a different mailbox. Re-run list-messages or search-messages to get ` +
          `a fresh id with its current mailbox path.`,
        error
      );
    case "mailbox-ambiguous":
      throw new DomainError(
        `The path ${JSON.stringify(requested ?? "")} matches more than one mailbox in ` +
          `account ${JSON.stringify(account ?? "")} (${candidates.join(", ")}): Mail ` +
          `exposes no identifier that tells true same-named siblings apart, so this is ` +
          `refused rather than resolved by guessing.`,
        error
      );
    default:
      throw new DomainError(`Mail refused the request (${code}).`, error);
  }
}
