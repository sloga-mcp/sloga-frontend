/**
 * Read the `type` of a failed API request. Kept import-free so node can
 * spec it.
 *
 * stoat-api throws the raw response body of a failed request as a string,
 * usually `{"type":"MissingPermission",...}`, but a proxy can return HTML.
 * An already-parsed body (an object with a string `type`) is read as is.
 *
 * @returns the error type, or undefined for anything that isn't an API error
 */
export function apiErrorType(error: unknown): string | undefined {
  let body: unknown = error;
  if (typeof error === "string") {
    try {
      body = JSON.parse(error);
    } catch {
      return undefined;
    }
  }

  if (typeof body !== "object" || body === null) return undefined;

  const type = (body as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}
