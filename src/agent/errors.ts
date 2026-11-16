/**
 * True when the database exists but has no tables yet (`npm run db:seed` was never run).
 * Drizzle wraps the driver error, so the whole `cause` chain is checked.
 */
export function isDatabaseNotReady(error: unknown): boolean {
  for (let current: unknown = error, depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error && /no such table/i.test(current.message)) return true;
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export const DATABASE_NOT_READY_MESSAGE =
  "The database is not set up yet. Run `npm run db:seed` in the project folder, then reload.";
