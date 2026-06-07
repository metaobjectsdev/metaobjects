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
// Tiering (ADR-0020 / ADR-0021 D1):
//   - "native"  — the recommended Tier-1 `meta gen` suite (idiomatic emission).
//   - "neutral" — Tier-2 artifacts owned by the neutral docs engine. `docs` and
//                 `mermaid-er` are present here for identity/discoverability but
//                 are NOT part of the recommended native surface — the canonical
//                 door for documentation is `meta docs` (D1).

import type { Generator } from "./generator.js";
import {
  entityFile,
  queriesFile,
  callableFile,
  routesFile,
  routesFileHono,
  barrel,
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
} from "./generators/index.js";

export type GeneratorTier = "native" | "neutral";

export interface GeneratorRegistryEntry {
  /** Stable, cross-port-consistent id. Equals the registry map key. */
  name: string;
  /** One-line (no newline) human description for `--list`. */
  description: string;
  /** "native" = recommended `meta gen` suite; "neutral" = `meta docs`-owned. */
  tier: GeneratorTier;
  /** Constructs the generator with sensible defaults. Calling it must not throw. */
  factory: () => Generator;
  /** Optional one-line options summary for `--list`. */
  options?: string;
  /** Optional note — used to point neutral entries at their canonical door. */
  note?: string;
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
  // ----- Tier-1 native suite (idiomatic per-port emission) -----------------
  entity: {
    name: "entity",
    description: "Per-entity Drizzle table + typed model module (the entity module).",
    tier: "native",
    factory: () => entityFile(),
    options: "filter?, target?",
  },
  queries: {
    name: "queries",
    description: "Per-entity typed query helpers (findById/create/...).",
    tier: "native",
    factory: () => queriesFile(),
    options: "filter?, target?",
  },
  callable: {
    name: "callable",
    description: "Per-entity callable/service surface wrapping the query helpers.",
    tier: "native",
    factory: () => callableFile(),
    options: "filter?, target?",
  },
  routes: {
    name: "routes",
    description: "Per-entity Fastify CRUD routes (drizzle-fastify mountCrudRoutes).",
    tier: "native",
    factory: () => routesFile(),
    options: "filter?, target?",
  },
  "routes-hono": {
    name: "routes-hono",
    description: "Per-entity Hono CRUD routes (runtime-ts/hono mountCrudRoutes).",
    tier: "native",
    factory: () => routesFileHono(),
    options: "filter?, target?",
  },
  barrel: {
    name: "barrel",
    description: "Single index.ts re-exporting every generated entity module.",
    tier: "native",
    factory: () => barrel(),
    options: "target?",
  },
  "prompt-render": {
    name: "prompt-render",
    description: "Per-template prompt-render helper over the render engine.",
    tier: "native",
    factory: () => promptRender(),
    options: "filter?, target?",
  },
  "output-parser": {
    name: "output-parser",
    description: "Per-template tolerant output parser (recover-on-receipt).",
    tier: "native",
    factory: () => outputParser(),
    options: "filter?, target?",
  },
  extractor: {
    name: "extractor",
    description: "Per-template typed extract<Name> helper (strict payload extraction).",
    tier: "native",
    factory: () => extractor(),
    options: "filter?, target?",
  },
  "output-prompt": {
    name: "output-prompt",
    description: "Per-template output-format prompt fragment generator.",
    tier: "native",
    factory: () => outputPrompt(),
    options: "filter?, target?",
  },
  "render-helper": {
    name: "render-helper",
    description: "Per-template.output render helper (document/email typed wrappers).",
    tier: "native",
    factory: () => renderHelper(),
    options: "filter?, target?",
  },
  template: {
    name: "template",
    description: "Generic Mustache template primitive (walk + template → files).",
    tier: "native",
    factory: () => templatePrimitive(),
    options: "name, walk, template, format?, filter?, provider?, target?",
  },
  "api-docs": {
    name: "api-docs",
    description:
      "Per-entity/template SDK API reference (the generated code's API, human + agent forms).",
    tier: "native",
    factory: () => apiDocsFile(),
    options: "filter?, target?",
  },

  "trace-helper": {
    name: "trace-helper",
    description: "Per-entity typed record<Entity>/call<Entity> trace helpers (extract + buildLlmCallRow + persist; LlmCallBase-derived entities only).",
    tier: "native",
    factory: () => traceHelperFile(),
    options: "outDir?, target?",
  },

  // ----- Tier-2 neutral (owned by the `meta docs` engine — D1 / ADR-0020) ---
  docs: {
    name: "docs",
    description: "Neutral per-entity / per-template Markdown documentation pages.",
    tier: "neutral",
    factory: () => docsFile(),
    note: "neutral artifact — use `meta docs` (the single docs door, ADR-0021 D1); not part of the recommended `meta gen` native suite.",
  },
  "mermaid-er": {
    name: "mermaid-er",
    description: "Mermaid ER diagram of the entity/relationship model.",
    tier: "neutral",
    factory: () => mermaidErDiagram(),
    note: "neutral artifact owned by the docs engine (ADR-0020); surfaced via `meta docs`, not the recommended `meta gen` native suite.",
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
