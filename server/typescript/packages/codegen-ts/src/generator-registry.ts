// ADR-0021 D3 — stable-name generator registry.
//
// Generators are identified by a STABLE string id (e.g. `entity`, `routes`,
// `render-helper`) rather than by a language-specific factory import. The id is
// the cross-port contract: the same logical generator carries the same stable
// name in every port. This module is the discoverability + identity surface
// behind `meta gen --list`.
//
// It is ADDITIVE. The existing `defineConfig({ generators: [entityFile(), ...] })`
// factory-array config keeps working unchanged — the registry powers `--list`
// and a stable identity, it does not replace the config path.
//
// **This is a SLICE, not the whole catalog.** `codegen-ts` cannot import
// `codegen-ts-react` / `codegen-ts-tanstack` (dependency direction), so those two
// packages export their own slices and the CLI unions all three
// (`cli/src/lib/catalog.ts`). Set equality against the cross-port manifest is a
// property of the COMPOSED catalog and is asserted there; this package's own
// conformance test can only check one direction — no rogue names.
//
// Tiering (ADR-0020 / ADR-0021 D1):
//   - "native"  — the recommended Tier-1 `meta gen` suite (idiomatic emission).
//   - "neutral" — Tier-2 artifacts owned by the neutral docs engine. `docs` and
//                 `mermaid-er` are present here for identity/discoverability but
//                 are NOT part of the recommended native surface — the canonical
//                 door for documentation is `meta docs` (D1).

import type { Generator } from "./generator.js";
import type { MetaobjectsGenConfig } from "./metaobjects-config.js";
import { REFERENCE_GENERATOR_NAMES } from "./reference-templates.js";
// The four ADR-0034 ownable generators are no longer exported from ./generators/index.js
// (1.0 removed them — see that file's header). They remain the engine's internal composers
// and the stable-name registry still constructs them, so import them from their own modules.
import { entityFile } from "./generators/entity-file.js";
import { queriesFile } from "./generators/queries-file.js";
import { routesFile } from "./generators/routes-file.js";
import { barrel } from "./generators/barrel.js";
import {
  callableFile,
  routesFileHono,
  namesFile,
  mermaidErDiagram,
  promptRender,
  outputParser,
  extractor,
  outputPrompt,
  renderHelper,
  apiDocsFile,
  docsFile,
  templateGenerator,
  traceHelperFile,
  sharedModelFile,
  requirementTests,
} from "./generators/index.js";

export type GeneratorTier = "native" | "neutral";

/**
 * The six layers a generator can belong to — the axis an adopter SELECTS BY.
 *
 * Cross-port: `layer` is gated by every port's registry-conformance test against
 * `fixtures/generator-registry-conformance/registry.json`, exactly as `tier` is, so a
 * polyglot agent groups the catalog by the same words everywhere.
 *
 * Six, not ten. The first four are app-shape decisions a builder makes; `docs` is on by
 * default (`meta docs`); `capability` holds the ones the MODEL has already made — nobody
 * picks `prompt-render` by browsing a taxonomy, they pick it because they declared a
 * `template.prompt`, which `meta gen --list --probe` reports with a real file count. A
 * layer with one member does no grouping work, so do not split `capability` to tidy it.
 */
export const GENERATOR_LAYERS = [
  "model",
  "persistence",
  "api",
  "client",
  "docs",
  "capability",
] as const;
export type Layer = (typeof GENERATOR_LAYERS)[number];

/**
 * The framework a generator's OUTPUT targets. Absent = framework-neutral.
 *
 * Exclusivity is an ADVISORY and only on the `api` layer (spec §8a): `routes` and
 * `routes-hono` emit to different paths, so wiring both is legal and silently produces
 * two HTTP surfaces — worth a warning, never an error, because migrating between them is
 * legitimate. There is NO general per-layer rule: `@metaobjectsdev/tanstack` peers on
 * `react`, so `form` (react) + `hooks`/`grid` (tanstack) is the intended composition.
 */
export type GeneratorFramework = "fastify" | "hono" | "react" | "tanstack";

export interface GeneratorRegistryEntry {
  /** Stable, cross-port-consistent id. Equals the registry map key. */
  name: string;
  /**
   * Catalog discriminator. Today every entry is a generator; FR-043 adds
   * `kind: "library"` rows to the same table rather than building a parallel one.
   */
  kind: "generator";
  /** The selection axis — see {@link GENERATOR_LAYERS}. Gated cross-port. */
  layer: Layer;
  /** One-line (no newline) human description for `--list`. */
  description: string;
  /** "native" = recommended `meta gen` suite; "neutral" = `meta docs`-owned. */
  tier: GeneratorTier;
  /** Constructs the generator with sensible defaults. Calling it must not throw. */
  factory: () => Generator;
  /** Optional one-line options summary for `--list`. */
  options?: string;
  /** The framework this generator's OUTPUT targets. Absent = framework-neutral. */
  framework?: GeneratorFramework;
  /**
   * Stable names whose emitted output THIS generator's output imports.
   *
   * Resolved, not trusted: a gate dry-runs every generator, resolves each emitted
   * RELATIVE import back to whichever generator emits that path, and asserts the result
   * is a subset of this list — so a generator that quietly starts depending on `entity`
   * cannot ship claiming it depends on nothing.
   */
  requires?: readonly string[];
  /** The `@metaobjectsdev` runtime package the EMITTED code imports, if any. */
  runtimePackage?: string;
  /**
   * Third-party packages the EMITTED code imports.
   *
   * Per generator rather than derived from {@link runtimePackage}, because
   * `@metaobjectsdev/runtime-ts`'s peers are a union (drizzle-orm, fastify, hono, kysely,
   * zod) — deriving per package would tell someone ejecting `entity` to install both
   * Fastify and Hono. Version RANGES are read from the runtime package's own
   * `peerDependencies`, never written here. Gated the same way `requires` is.
   */
  runtimePeers?: readonly string[];
  /**
   * Config keys this generator reads. Typed against the real config so a renamed key
   * breaks the build instead of going quietly stale — the same "resolved, not trusted"
   * doctrine as `requires`, obtained here for free from the type system.
   */
  configKeys?: readonly (keyof MetaobjectsGenConfig)[];
  /** True iff this package ships a `src/reference/<name>.ts` for `meta eject`. */
  ejectable: boolean;
  /** Optional note — used to point neutral entries at their canonical door. */
  note?: string;
}

/** True iff this package ships a copyable reference template for `name`. */
function ejectable(name: string): boolean {
  return (REFERENCE_GENERATOR_NAMES as readonly string[]).includes(name);
}

// The `template` generator is a PRIMITIVE: callers supply { name, walk,
// template }. For registry identity + `--list` we expose a no-op default so the
// factory constructs a valid Generator without throwing; real use passes opts
// via the config factory-array path. (docsFile() is the first instance of this
// primitive — see template-generator.ts.)
function templatePrimitive(): Generator {
  return templateGenerator({
    name: "template",
    template: "",
    walk: () => [],
  });
}

export const generatorRegistry: Record<string, GeneratorRegistryEntry> = {
  // ----- model ------------------------------------------------------------
  entity: {
    name: "entity",
    kind: "generator",
    layer: "model",
    description: "Per-entity Drizzle table + typed model module (the entity module).",
    tier: "native",
    factory: () => entityFile(),
    options: "filter?, target?",
    ejectable: ejectable("entity"),
  },
  names: {
    name: "names",
    kind: "generator",
    layer: "model",
    description: "Per-entity physical database name constants (table/view, schema, columns).",
    tier: "native",
    factory: () => namesFile(),
    options: "filter?, target?",
    ejectable: ejectable("names"),
  },
  barrel: {
    name: "barrel",
    kind: "generator",
    layer: "model",
    description: "Single index.ts re-exporting every generated entity module.",
    tier: "native",
    factory: () => barrel(),
    options: "target?",
    ejectable: ejectable("barrel"),
  },

  // ----- persistence ------------------------------------------------------
  queries: {
    name: "queries",
    kind: "generator",
    layer: "persistence",
    description: "Per-entity typed query helpers (findById/create/...).",
    tier: "native",
    factory: () => queriesFile(),
    options: "filter?, target?",
    ejectable: ejectable("queries"),
  },

  // ----- api --------------------------------------------------------------
  routes: {
    name: "routes",
    kind: "generator",
    layer: "api",
    description: "Per-entity Fastify CRUD routes (drizzle-fastify mountCrudRoutes).",
    tier: "native",
    factory: () => routesFile(),
    options: "filter?, target?",
    framework: "fastify",
    ejectable: ejectable("routes"),
  },
  "routes-hono": {
    name: "routes-hono",
    kind: "generator",
    layer: "api",
    description: "Per-entity Hono CRUD routes (runtime-ts/hono mountCrudRoutes).",
    tier: "native",
    factory: () => routesFileHono(),
    options: "filter?, target?",
    framework: "hono",
    ejectable: ejectable("routes-hono"),
  },

  // ----- docs -------------------------------------------------------------
  "api-docs": {
    name: "api-docs",
    kind: "generator",
    layer: "docs",
    description:
      "Per-entity/template SDK API reference (the generated code's API, human + agent forms).",
    tier: "native",
    factory: () => apiDocsFile(),
    options: "filter?, target?",
    ejectable: ejectable("api-docs"),
  },
  docs: {
    name: "docs",
    kind: "generator",
    layer: "docs",
    description: "Neutral per-entity / per-template Markdown documentation pages.",
    tier: "neutral",
    factory: () => docsFile(),
    ejectable: ejectable("docs"),
    note: "neutral artifact — use `meta docs` (the single docs door, ADR-0021 D1); not part of the recommended `meta gen` native suite.",
  },
  "mermaid-er": {
    name: "mermaid-er",
    kind: "generator",
    layer: "docs",
    description: "Mermaid ER diagram of the entity/relationship model.",
    tier: "neutral",
    factory: () => mermaidErDiagram(),
    ejectable: ejectable("mermaid-er"),
    note: "neutral artifact owned by the docs engine (ADR-0020); surfaced via `meta docs`, not the recommended `meta gen` native suite.",
  },

  // ----- capability -------------------------------------------------------
  // Not chosen by browsing this list — chosen because the MODEL already asks for
  // them. `meta gen --list --probe` reports a real file count per entry.
  callable: {
    name: "callable",
    kind: "generator",
    layer: "capability",
    description: "Per-entity callable/service surface wrapping the query helpers.",
    tier: "native",
    factory: () => callableFile(),
    options: "filter?, target?",
    ejectable: ejectable("callable"),
  },
  "prompt-render": {
    name: "prompt-render",
    kind: "generator",
    layer: "capability",
    description: "Per-template prompt-render helper over the render engine.",
    tier: "native",
    factory: () => promptRender(),
    options: "filter?, target?",
    ejectable: ejectable("prompt-render"),
  },
  "output-parser": {
    name: "output-parser",
    kind: "generator",
    layer: "capability",
    description: "Per-template tolerant output parser (recover-on-receipt).",
    tier: "native",
    factory: () => outputParser(),
    options: "filter?, target?",
    ejectable: ejectable("output-parser"),
  },
  extractor: {
    name: "extractor",
    kind: "generator",
    layer: "capability",
    description: "Per-template typed extract<Name> helper (strict payload extraction).",
    tier: "native",
    factory: () => extractor(),
    options: "filter?, target?",
    ejectable: ejectable("extractor"),
  },
  "output-prompt": {
    name: "output-prompt",
    kind: "generator",
    layer: "capability",
    description: "Per-template output-format prompt fragment generator.",
    tier: "native",
    factory: () => outputPrompt(),
    options: "filter?, target?",
    ejectable: ejectable("output-prompt"),
  },
  "render-helper": {
    name: "render-helper",
    kind: "generator",
    layer: "capability",
    description: "Per-template.output render helper (document/email typed wrappers).",
    tier: "native",
    factory: () => renderHelper(),
    options: "filter?, target?",
    ejectable: ejectable("render-helper"),
  },
  template: {
    name: "template",
    kind: "generator",
    layer: "capability",
    description: "Generic Mustache template primitive (walk + template → files).",
    tier: "native",
    factory: () => templatePrimitive(),
    options: "name, walk, template, format?, filter?, provider?, target?",
    ejectable: ejectable("template"),
  },
  "trace-helper": {
    name: "trace-helper",
    kind: "generator",
    layer: "capability",
    description:
      "Per-entity typed record<Entity>/call<Entity> trace helpers (extract + buildLlmCallRow + persist; LlmCallBase-derived entities only).",
    tier: "native",
    factory: () => traceHelperFile(),
    options: "outDir?, target?",
    ejectable: ejectable("trace-helper"),
  },
  "requirement-tests": {
    name: "requirement-tests",
    kind: "generator",
    layer: "capability",
    description: "Per-requirement test stub, one per requirement.functional claim in the ledger.",
    tier: "native",
    factory: () => requirementTests(),
    options: "filter?, target?",
    ejectable: ejectable("requirement-tests"),
  },
  "shared-model": {
    name: "shared-model",
    kind: "generator",
    layer: "capability",
    description:
      "FR-023: a publisher's flattened shared-model artifact + manifest for a consumer's `meta deps sync`.",
    tier: "native",
    // `name`/`include` are required at run time (an empty include matches
    // everything, so a placeholder here constructs without throwing — real use
    // always supplies both, same as `template`'s templatePrimitive() above).
    factory: () => sharedModelFile({ name: "shared-model", include: [] }),
    options: "name, include, exclude?, files?, version?, target?",
    ejectable: ejectable("shared-model"),
  },
};

/** All registry entries, native first then neutral, alphabetical within tier. */
export function listGenerators(): GeneratorRegistryEntry[] {
  const entries = Object.values(generatorRegistry);
  const byName = (a: GeneratorRegistryEntry, b: GeneratorRegistryEntry) =>
    a.name.localeCompare(b.name);
  return [
    ...entries.filter((e) => e.tier === "native").sort(byName),
    ...entries.filter((e) => e.tier === "neutral").sort(byName),
  ];
}

/** Resolve a generator entry by its stable id, or undefined if unknown. */
export function getGenerator(id: string): GeneratorRegistryEntry | undefined {
  return generatorRegistry[id];
}
