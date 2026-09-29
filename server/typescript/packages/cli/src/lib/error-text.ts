// The text to print for a caught error. `(err as Error).message` is empty for an
// AggregateError such as a refused Postgres connection on a dual-stack host, where the
// detail lives on the inner errors, so a bare `.message` printed nothing after the colon.

export function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  if (err.message) return err.message;
  if (err instanceof AggregateError && err.errors.length > 0) {
    return err.errors.map(describeError).join("; ");
  }
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" && code ? code : err.name;
}
