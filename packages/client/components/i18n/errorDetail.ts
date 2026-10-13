/**
 * Plain-text parts of API error messages. Kept import-free so node can spec
 * it.
 *
 * The backend no longer sends an error's source `location` to clients, so
 * nothing here may read it: it would print "undefined".
 */

/**
 * What to show in brackets after the database error message: the failed
 * operation when the server names one, otherwise the error type.
 */
export function databaseErrorDetail(err: {
  type: string;
  operation?: unknown;
}): string {
  return typeof err.operation === "string" && err.operation
    ? err.operation
    : err.type;
}

/**
 * Text for an API error that has no translated message of its own.
 */
export function untranslatedErrorText(err: { type: string }): string {
  return err.type;
}
