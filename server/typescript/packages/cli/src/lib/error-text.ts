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

/**
 * The lines that say where a caught error came from: one `caused by:` line per error on its
 * `cause` chain, each with the frame it was thrown at, and with `verbose` that error's whole
 * stack. A generator throw reaches `meta gen` wrapped as `[<generator>] <message>`, so the
 * wrapper's own message and stack name the runner, not the template line that threw; an owned
 * template broken by an engine API change was reported as a bare "x is not a function" with
 * nothing to say which file to fix. An error with no cause gets its own stack under `verbose`,
 * and nothing otherwise.
 */
export function describeErrorCause(err: unknown, verbose: boolean): string[] {
  const lines: string[] = [];
  const seen = new Set<unknown>([err]);
  let hasStack = false;
  let cur: unknown = err instanceof Error ? err.cause : undefined;
  while (cur !== undefined && cur !== null && !seen.has(cur)) {
    seen.add(cur);
    if (!(cur instanceof Error)) {
      lines.push(`caused by: ${String(cur)}`);
      break;
    }
    const frames = stackFrames(cur);
    if (frames.length > 0) hasStack = true;
    const at = !verbose && frames.length > 0 ? ` (${frames[0]})` : "";
    lines.push(`caused by: ${cur.name}: ${describeError(cur)}${at}`);
    if (verbose) lines.push(...frames.map((f) => `    ${f}`));
    cur = cur.cause;
  }
  if (lines.length === 0) {
    if (verbose && err instanceof Error) lines.push(...stackFrames(err).map((f) => `    ${f}`));
    return lines;
  }
  if (!verbose && hasStack) lines.push("run again with --verbose for the full stack");
  return lines;
}

/** The `at ...` frames of an error's stack, without the leading `Name: message` line(s). */
function stackFrames(err: Error): string[] {
  if (typeof err.stack !== "string") return [];
  return err.stack.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("at "));
}
