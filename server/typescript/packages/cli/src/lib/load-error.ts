import type { LoaderError } from "@metaobjectsdev/metadata";

/**
 * One rendering of a metadata LOAD failure, for every command that can hit one.
 *
 * The loader builds a full ADR-0009 envelope — a stable `code`, the `files` the node came
 * from, the `jsonPath` inside the document, and often `suggestions[]` naming the next step.
 * Five commands then printed `` `failed to load metadata: ${err.message}` `` and threw all
 * of it away. So `ERR_ABSTRACT_SUBTYPE_AUTHORED` reached an adopter as a paragraph with no
 * file, no line, no node name and no code — and `--format json` carried the same bare
 * string, so a CI job could not key on the code ADR-0009 promises and the docs name. Five
 * metadata files made that a `grep`; two hundred would not.
 *
 * This does not invent provenance. It reports exactly what the error carries and stays
 * silent about what it does not, so a caller can never read more precision into the line
 * than the loader actually had.
 */
export interface LoadErrorReport {
  /** The message plus whatever provenance the envelope carried, for a human. */
  readonly text: string;
  /** ADR-0009 stable code, when the loader attached one. */
  readonly code?: string;
  /** The file(s) the failing node was read from. */
  readonly files?: readonly string[];
  /** JSON path of the failing node within its document. */
  readonly jsonPath?: string;
  /** The loader's own next steps. Printed verbatim; never paraphrased. */
  readonly suggestions?: readonly string[];
}

/** True for a thrown value carrying the loader's ADR-0009 envelope. */
function isLoaderError(err: unknown): err is LoaderError {
  return (
    typeof err === "object" && err !== null
    && typeof (err as { code?: unknown }).code === "string"
    && typeof (err as { source?: unknown }).source === "object"
  );
}

export function describeLoadError(err: unknown): LoadErrorReport {
  const message = err instanceof Error ? err.message : String(err);
  if (!isLoaderError(err)) return { text: message };

  const source = err.source as { files?: readonly string[]; jsonPath?: string };
  const files = source.files?.filter((f) => f.length > 0);
  const jsonPath = source.jsonPath;
  const suggestions = err.suggestions?.filter((s) => s.length > 0);

  // `code` first: it is the one part a machine keys on, and a human scanning a terminal
  // finds it fastest at the front of the line. Then WHERE, which is the question the
  // message itself can never answer.
  const where = [
    files !== undefined && files.length > 0 ? files.join(", ") : undefined,
    jsonPath !== undefined && jsonPath.length > 0 ? `at ${jsonPath}` : undefined,
  ].filter((p): p is string => p !== undefined).join(" ");

  const head = `${err.code}: ${message}`;
  return {
    text: where.length > 0 ? `${head}\n  in ${where}` : head,
    code: err.code,
    ...(files !== undefined && files.length > 0 ? { files } : {}),
    ...(jsonPath !== undefined && jsonPath.length > 0 ? { jsonPath } : {}),
    ...(suggestions !== undefined && suggestions.length > 0 ? { suggestions } : {}),
  };
}

/**
 * Print a load failure the one way every command prints it: the described line, then the
 * loader's own `suggestions[]` indented beneath it, verbatim.
 *
 * This lived as a byte-identical private copy in `docs.ts`, `gen.ts` and `migrate.ts`. It
 * belongs beside `describeLoadError` for the same reason that function exists: the rendering
 * of a load failure is ONE decision, and three copies of it are three places for the next
 * improvement to reach two of. `verify.ts`'s variant is deliberately NOT this — it chooses
 * between the loader's suggestions and its own strict-attr hint (ADR-0023), which is a
 * different decision, not a different spelling of this one.
 *
 * `log` is a parameter rather than an import so a test can capture what was printed without
 * reaching into module state.
 */
export function reportLoadError(
  log: { error: (msg: string) => void },
  prefix: string,
  err: unknown,
): void {
  const report = describeLoadError(err);
  log.error(`${prefix}: ${report.text}`);
  for (const s of report.suggestions ?? []) log.error(`  ${s}`);
}
