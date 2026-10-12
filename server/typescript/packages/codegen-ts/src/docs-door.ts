// The docs door's seam for an owned docs generator (ADR-0034 Amendment 7).
//
// `meta docs` is the one door for documentation (ADR-0021 D1, ADR-0025), and it used to
// construct the packaged `docsFile()` / `apiDocsFile()` itself, with options it computed
// from the `docs:` config. There was nothing an owned copy could be handed to, so the two
// generators could not be ejected. The seam has two halves:
//
//   - WHICH generator runs. An owned copy is listed in the docs door's own config,
//     `docs: { generators: [...] }`, and carries `docsSurface`. It replaces the packaged
//     generator for that surface (`docsDoorGenerators`). It is not listed in the top-level
//     `generators`: that array is what `meta gen` runs, and `meta gen` does not run docs.
//   - WHAT the door tells it. The facts the door used to pass as factory options now ride
//     on the context (`ctx.docsDoor`), because a listed generator is already constructed by
//     the time the door sees it. They are the facts the two page sets must agree on (where
//     the api pages are, whether the model pages exist), so the door states them once and
//     both generators read the same answer.
import type { ColumnNamingStrategy } from "@metaobjectsdev/metadata";
import type { AgentSchemaInput } from "./generators/agent-schema-input.js";
import type { Generator, OwnedDocsSurface } from "./generator.js";

/**
 * What the docs door tells the generator it runs for a surface. Present on `ctx.docsDoor`
 * only under `meta docs` / `meta verify --docs`; absent on a `meta gen` run and on a direct
 * `.generate(ctx)` call.
 */
export interface DocsDoorFacts {
  /** For the MODEL surface: the api surfaces emitted alongside it, which every model page
   *  and the index link to. Absent: the model pages link to none. */
  readonly apiSurfaces?: ReadonlyArray<{ label: string; subDir: string; baseUrl?: string }>;
  /** For the API surface: the directory under the docs root its pages go in. */
  readonly apiSubDir?: string;
  /** For the API surface: whether the model surface is emitted alongside it, so each api
   *  page can link back to its model page. */
  readonly modelSurface?: boolean;
  /** For the AGENT surface: what `meta docs` computes for it and codegen-ts deliberately does
   *  not — the physical schema, resolved with the project's dialect, and the project's column
   *  naming strategy. Absent: the schema page is not written. */
  readonly agent?: { readonly schema?: AgentSchemaInput; readonly columnNamingStrategy?: ColumnNamingStrategy };
}

/**
 * The owned generator for each surface out of `docs.generators`, keyed by surface. A
 * surface with no entry is run by the packaged generator.
 *
 * Refused rather than resolved by order or ignored, each naming the entry:
 *   - an entry with no `docsSurface`. The door runs one generator per surface and has no
 *     surface to give it, so running it or dropping it would both be a guess. The
 *     packaged `docsFile()` / `apiDocsFile()` carry no marker and need no listing; a
 *     generator `meta gen` runs belongs in the top-level `generators`.
 *   - two entries for one surface. Each would write the same pages, and picking one
 *     silently is the two-answers defect the single door exists to prevent.
 */
export function docsDoorGenerators(
  generators: readonly Generator[],
): Partial<Record<OwnedDocsSurface, Generator>> {
  const bySurface: Partial<Record<OwnedDocsSurface, Generator>> = {};
  for (const generator of generators) {
    const surface = generator.docsSurface;
    if (surface === undefined) {
      throw new Error(
        `\`docs.generators\` lists "${generator.name}", which carries no \`docsSurface\`: ` +
          "`meta docs` runs one generator per surface (model, api, requirements, agent) and cannot " +
          "tell which one this replaces. An owned copy from `meta eject docs`, `api-docs`, " +
          "`requirements` or `agent-docs` carries it. The packaged docs generators need no " +
          "listing, and a generator " +
          "`meta gen` runs belongs in the top-level `generators`.",
      );
    }
    const first = bySurface[surface];
    if (first !== undefined) {
      throw new Error(
        `\`docs.generators\` lists two generators for the ${surface} surface ` +
          `("${first.name}" and "${generator.name}"): \`meta docs\` runs one per surface. ` +
          "Keep one of them.",
      );
    }
    bySurface[surface] = generator;
  }
  return bySurface;
}
