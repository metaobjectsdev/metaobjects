import { relative, isAbsolute } from "node:path";
import { unknownAttributeFindings, type LoadMemoryOptions } from "@metaobjectsdev/sdk";

/**
 * The trailing advice on every unknown-attribute warning `meta gen` prints. `gen` has no
 * `--strict` flag of its own — `meta verify` is the strict door (ADR-0023), so that is what
 * the warning names.
 */
export const UNKNOWN_ATTR_GEN_ADVICE =
  "meta gen loads leniently and generated anyway, but `meta verify` rejects this metadata " +
  "(ADR-0023): fix or remove the attribute — a typo'd one (`isAbstrakt`, `@requird`) " +
  "silently changes what is generated.";

/**
 * `meta gen`'s unknown-attribute warnings: one line per ADR-0023 finding a STRICT load of
 * the same collection raises, naming the attribute, the node and the file. Empty when the
 * model is clean; the caller prints {@link UNKNOWN_ATTR_GEN_ADVICE} once after them.
 *
 * `gen` itself keeps loading leniently and keeps its exit code; this only ends the silence
 * between it and `meta verify`, which fails on the very same file. Files are printed
 * relative to `projectRoot` when the loader recorded an absolute path.
 */
export async function unknownAttrWarnings(
  configDir: string,
  options: LoadMemoryOptions,
  projectRoot: string,
): Promise<string[]> {
  let findings;
  try {
    findings = await unknownAttributeFindings(configDir, options);
  } catch {
    // The lenient load already succeeded; a strict re-load that cannot even complete has
    // nothing more precise to say, and must never turn an advisory into a failure.
    return [];
  }
  return findings.map((f) => {
    const source = f.source as { files?: readonly string[]; jsonPath?: string };
    const files = (source.files ?? [])
      .filter((p) => p.length > 0)
      .map((p) => (isAbsolute(p) ? relative(projectRoot, p) : p));
    const where = [
      files.length > 0 ? files.join(", ") : undefined,
      source.jsonPath !== undefined && source.jsonPath.length > 0 ? `at ${source.jsonPath}` : undefined,
    ].filter((w): w is string => w !== undefined).join(" ");
    const head = `${f.code}: ${f.message}`;
    return where.length > 0 ? `${head}\n  in ${where}` : head;
  });
}
