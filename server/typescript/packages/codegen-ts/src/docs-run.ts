// The facts the documentation pages of one run must agree on (ADR-0034 Amendment 9).
//
// Documentation is written by generators the project lists, like every other output. Two of
// them write pages that link to each other: the model pages (`docsFile()`) link to the api
// reference (`apiDocsFile()`), and each api page links back to its model page. Neither
// generator can see the other, so the runner states what both must agree on once, per target,
// from the generators the list declares, and hands it to each on `ctx.docs`. The schema
// `agent/schema.md` describes rides here too: it is computed by the caller that owns the
// schema builder (`meta gen` and `meta verify --codegen`), which codegen-ts cannot import.
//
// ENGINE: a model of the run, not emitted text, so an owned docs generator keeps reading it
// from the package.
import type { Generator } from "./generator.js";
import type { AgentSchemaInput } from "./generators/agent-schema-input.js";
import { apiLabel } from "./generators/api-label.js";

/**
 * The target every documentation generator writes to unless its `target` option names
 * another. A run that lists one while `targets` declares no such entry is refused, naming the
 * generator: documentation is never written into the code's output directory by default.
 */
export const DOCS_TARGET_NAME = "docs";

/** One set of api reference pages the model pages link to. */
export interface DocsApiSurface {
  readonly label: string;
  /** The directory the pages are in, under the docs root. */
  readonly subDir: string;
  /** Set when the pages are hosted elsewhere: links are then absolute, `<baseUrl>/<page>`. */
  readonly baseUrl?: string;
}

/** `ctx.docs`: what the documentation generators in one target must agree on. */
export interface DocsRunFacts {
  /** The api reference pages in the same target (`emitsApiDocs`), for the model pages to link. */
  readonly apiSurfaces: readonly DocsApiSurface[];
  /** Whether the model pages are written to the same target (`emitsModelDocs`), so an api
   *  page can link back to its model page. */
  readonly modelPages: boolean;
  /**
   * The physical schema for `agent/schema.md`, built on first call by the caller that owns
   * the schema builder, with the project's dialect and column naming. Undefined when the
   * caller supplied none (a programmatic `runGen()`), or when the schema cannot be described
   * truthfully, in which case the caller has said why.
   */
  readonly agentSchema?: () => AgentSchemaInput | undefined;
}

/** The facts for the generators that write into one target. */
export function docsRunFacts(
  inTarget: readonly Generator[],
  agentSchema: (() => AgentSchemaInput | undefined) | undefined,
): DocsRunFacts {
  const apiSurfaces: DocsApiSurface[] = [];
  for (const g of inTarget) {
    if (g.emitsApiDocs !== undefined) apiSurfaces.push({ label: apiLabel("ts"), subDir: g.emitsApiDocs.subDir });
  }
  return {
    apiSurfaces,
    modelPages: inTarget.some((g) => g.emitsModelDocs === true),
    ...(agentSchema !== undefined && { agentSchema }),
  };
}

/**
 * Memoize a schema builder so it runs at most once per run, and only when a generator asks:
 * a run that lists no `agentDocsFile()` never builds a schema, and never prints the reasons
 * one could not be built.
 */
export function onceAgentSchema(
  build: () => AgentSchemaInput | undefined,
): () => AgentSchemaInput | undefined {
  let done = false;
  let value: AgentSchemaInput | undefined;
  return () => {
    if (!done) {
      value = build();
      done = true;
    }
    return value;
  };
}
