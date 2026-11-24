import { createHash } from 'node:crypto';

/**
 * Content digest of the validated, normalized rows of an import, in file order.
 * Equal rows give equal digests regardless of spacing or line endings.
 */
export function digestRows(rows) {
  const canonical = JSON.stringify(
    rows.map((row) => [
      row.date,
      row.description,
      row.category,
      row.accountId,
      row.amountCents,
      row.currency,
    ]),
  );
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Decides what a stored batch means for a retry under the same key.
 * A batch stored before digests existed has nothing to compare and replays.
 * The digest never leaves the server: callers receive the public batch only.
 */
export function resolveReplay(existing, digest) {
  const { payloadDigest, ...batch } = existing;
  if (!payloadDigest || payloadDigest === digest) {
    return { ...batch, replayed: true };
  }
  return { conflict: true };
}
