// `meta gen --list` — the catalog as one machine-readable document.
//
// The governing rule (opt-in-codegen design §1): stop hard-coding selection decisions
// into the CLI. The tool's job is to describe what it can do, accurately, and to make
// each choice cheap to act on. Deciding WHICH generators an application needs belongs
// to whoever is building it — increasingly an LLM working in the repo, which is well
// able to make that call given a truthful catalog and is badly served by a default that
// pre-empts it.
//
// Two questions this answers, kept apart on purpose (§D5):
//
//   APPLICABILITY — "would this emit anything for MY model?" — is `--probe`, which
//     cannot drift, because it does not describe the generators, it RUNS them.
//   COMPATIBILITY — "what does this need in order to work?" — is declared
//     (`requires`, `runtimePeers`) and therefore has to be gated separately.
//
// Conflating the two is how a catalog goes quietly wrong as frameworks are added.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { MetaData } from "@metaobjectsdev/metadata";
import {
  runGen,
  type GeneratorRegistryEntry,
  type Layer,
  type MetaobjectsGenConfig,
} from "@metaobjectsdev/codegen-ts";
import * as coreTpl from "@metaobjectsdev/codegen-ts";
import * as reactTpl from "@metaobjectsdev/codegen-ts-react";
import * as tanstackTpl from "@metaobjectsdev/codegen-ts-tanstack";
import { listCatalog, packageOf } from "./catalog.js";
import { installSetFor } from "./install-set.js";
import { readPackageManifest, declaredDependencyNames } from "./package-manifest.js";

/** One `--list` row. The cross-port subset is name / layer / tier / description. */
export interface CatalogRow {
  name: string;
  kind: "generator";
  layer: Layer;
  framework?: string;
  tier: "native" | "neutral";
  package: string;
  description: string;
  /** From the reference template's `use-when:` header. Absent for a non-ejectable entry. */
  useWhen?: string;
  /** From the reference template's `emits:` header. Absent for a non-ejectable entry. */
  emits?: string;
  requires?: readonly string[];
  configKeys?: readonly string[];
  install: { dev: string[]; runtime: string[] };
  source: {
    kind: "reference-template" | "package-only";
    ejectable: boolean;
    /** Whether this project already owns a copy. `null` with no project. */
    owned: boolean | null;
  };
  project?: {
    /** Wired in this project's `generators: [...]`. */
    wired: boolean;
    /** This generator's framework is a declared dependency. `null` when neutral or unknown. */
    frameworkDetected: boolean | null;
    /** Files this generator WOULD emit for this model. `null` unless --probe. */
    wouldEmit: number | null;
    /** Why `wouldEmit` is null despite --probe. Absent when it is a number. */
    probeError?: string;
  };
}

/** Where an ejected copy lands — mirrors `eject.ts`'s constant of the same name. */
const OWNED_GENERATORS_DIR = "codegen/generators";

/** The npm package a framework token names, for `frameworkDetected`. */
const FRAMEWORK_PACKAGE: Record<string, string> = {
  fastify: "fastify",
  hono: "hono",
  react: "react",
  tanstack: "@tanstack/react-query",
};

// ---------------------------------------------------------------------------
// reference-template headers
// ---------------------------------------------------------------------------

/** The three packages that ship reference templates, and their roots. */
const TEMPLATE_ROOTS: ReadonlyArray<readonly [readonly string[], () => string]> = [
  [coreTpl.REFERENCE_GENERATOR_NAMES, coreTpl.resolveReferenceRoot],
  [reactTpl.REFERENCE_GENERATOR_NAMES, reactTpl.resolveReferenceRoot],
  [tanstackTpl.REFERENCE_GENERATOR_NAMES, tanstackTpl.resolveReferenceRoot],
];

/**
 * A `// <facet>:  <text>` header line and its indented continuations, unwrapped.
 *
 * Read from the template rather than restated in the registry entry, for the same
 * reason `eject` reads its import line from the header: the template is the thing an
 * adopter opens, so a second copy of its own summary in the registry is a second thing
 * to keep in step. A test asserts every ejectable entry's row actually carries these.
 */
function headerFacet(source: string, facet: string): string | undefined {
  const lines = source.split("\n");
  const start = lines.findIndex((l) => l.startsWith(`// ${facet}:`));
  if (start === -1) return undefined;
  const parts = [lines[start]!.slice(`// ${facet}:`.length).trim()];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i]!;
    // A continuation is a comment line indented past the facet column and NOT itself a
    // new `facet:` line. Anything else ends the block.
    if (!/^\/\/ {3,}\S/.test(line) || /^\/\/ {3,}[a-z-]+: /.test(line)) break;
    parts.push(line.replace(/^\/\/\s+/, "").trim());
  }
  return parts.join(" ").trim() || undefined;
}

function readTemplate(name: string): string | undefined {
  for (const [names, root] of TEMPLATE_ROOTS) {
    if (!names.includes(name)) continue;
    try {
      return readFileSync(join(root(), `${name}.ts`), "utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the probe
// ---------------------------------------------------------------------------

/**
 * The project facts a `--list` row can carry. All optional: `--list` with no project at
 * all is the documented shape (`meta types` behaves the same way), because "what CAN
 * this engine do" is a question about the installed engine, not about a repo.
 */
export interface CatalogProject {
  projectRoot: string;
  config: MetaobjectsGenConfig;
  /** Stable names of the wired generators, as far as they can be identified. */
  wiredNames: ReadonlySet<string>;
  /** Owned copies present under `codegen/generators/`. */
  ownedNames: ReadonlySet<string>;
  /** Declared dependency names from package.json, for `frameworkDetected`. */
  declaredDeps: ReadonlySet<string> | undefined;
}

export interface CatalogListingOpts {
  project?: CatalogProject;
  /** Run every generator in memory and report a real file count. Needs `project` + `metadata`. */
  probe?: { metadata: MetaData; scope?: (fqn: string) => boolean };
}

/**
 * Dry-run ONE generator and count what it would emit.
 *
 * One `runGen` per generator rather than one run over all of them, for isolation: a
 * generator that throws (or one whose real use requires options `--list` cannot supply,
 * like `template` and `shared-model`) must report itself and leave every other row
 * intact. `dryRun` touches nothing on disk.
 */
async function probeOne(
  entry: GeneratorRegistryEntry,
  project: CatalogProject,
  metadata: MetaData,
  scope: ((fqn: string) => boolean) | undefined,
): Promise<{ count: number } | { error: string }> {
  try {
    const result = await runGen({
      config: { ...project.config, generators: [entry.factory()] },
      metadata,
      projectRoot: project.projectRoot,
      dryRun: true,
      ...(scope !== undefined ? { scope } : {}),
    });
    return { count: result.files.length };
  } catch (err) {
    return { error: (err as Error).message };
  }
}

// ---------------------------------------------------------------------------
// the listing
// ---------------------------------------------------------------------------

export async function buildCatalogListing(opts: CatalogListingOpts = {}): Promise<CatalogRow[]> {
  const rows: CatalogRow[] = [];

  for (const entry of listCatalog()) {
    const template = entry.ejectable ? readTemplate(entry.name) : undefined;
    const install = installSetFor([entry]);
    const pkg = packageOf(entry.name) ?? "";

    const row: CatalogRow = {
      name: entry.name,
      kind: entry.kind,
      layer: entry.layer,
      ...(entry.framework !== undefined ? { framework: entry.framework } : {}),
      tier: entry.tier,
      package: pkg,
      description: entry.description,
      ...(template !== undefined && headerFacet(template, "use-when") !== undefined
        ? { useWhen: headerFacet(template, "use-when")! }
        : {}),
      ...(template !== undefined && headerFacet(template, "emits") !== undefined
        ? { emits: headerFacet(template, "emits")! }
        : {}),
      ...(entry.requires !== undefined ? { requires: entry.requires } : {}),
      ...(entry.configKeys !== undefined ? { configKeys: entry.configKeys } : {}),
      install: { dev: install.dev, runtime: install.runtime },
      source: {
        kind: entry.ejectable ? "reference-template" : "package-only",
        ejectable: entry.ejectable,
        owned: opts.project === undefined ? null : opts.project.ownedNames.has(entry.name),
      },
    };

    if (opts.project !== undefined) {
      const project = opts.project;
      const fw = entry.framework;
      const frameworkDetected =
        fw === undefined || project.declaredDeps === undefined
          ? null
          : project.declaredDeps.has(FRAMEWORK_PACKAGE[fw] ?? fw);

      let wouldEmit: number | null = null;
      let probeError: string | undefined;
      if (opts.probe !== undefined) {
        const outcome = await probeOne(entry, project, opts.probe.metadata, opts.probe.scope);
        if ("count" in outcome) wouldEmit = outcome.count;
        else probeError = outcome.error;
      }

      row.project = {
        wired: project.wiredNames.has(entry.name),
        frameworkDetected,
        wouldEmit,
        ...(probeError !== undefined ? { probeError } : {}),
      };
    }

    rows.push(row);
  }

  return rows;
}

/**
 * The stable names wired in a config.
 *
 * `generators: [...]` holds constructed Generator objects (and, since ADR-0021 #1,
 * bare stable-name strings). A constructed generator carries its own kebab-case `name`,
 * which IS the stable name for every catalog entry — the registry's factory is what
 * produced it. A generator whose name is not a catalog key is an owned or third-party
 * one and simply contributes nothing here.
 */
export function wiredGeneratorNames(config: MetaobjectsGenConfig): Set<string> {
  const names = new Set<string>();
  for (const spec of config.generators ?? []) {
    if (typeof spec === "string") names.add(spec);
    else if (typeof spec?.name === "string") names.add(spec.name);
  }
  return names;
}

/** Owned copies present under `codegen/generators/` in this project. */
export function ownedGeneratorNames(projectRoot: string): Set<string> {
  const owned = new Set<string>();
  for (const entry of listCatalog()) {
    if (!entry.ejectable) continue;
    try {
      readFileSync(join(projectRoot, OWNED_GENERATORS_DIR, `${entry.name}.ts`), "utf8");
      owned.add(entry.name);
    } catch {
      // absent — not owned
    }
  }
  return owned;
}

/** Declared dependency names, or undefined when there is no readable manifest. */
export function declaredDepsOf(projectRoot: string): Set<string> | undefined {
  const pkg = readPackageManifest(projectRoot);
  return pkg === undefined ? undefined : declaredDependencyNames(pkg);
}

// ---------------------------------------------------------------------------
// text rendering
// ---------------------------------------------------------------------------

const LAYER_BLURB: Record<Layer, string> = {
  model: "the entity modules and the constants beside them",
  persistence: "how rows are read and written",
  api: "the HTTP surface — pick ONE framework",
  client: "the browser tier — form + hooks + grid compose, they do not conflict",
  docs: "on by default; the canonical door is `meta docs`",
  capability: "chosen by your MODEL, not by browsing — run --probe",
};

/** The human rendering: grouped by layer, because layer is the axis you select by. */
export function renderCatalogText(rows: CatalogRow[], probed: boolean): string {
  const lines: string[] = [];
  lines.push("Generator catalog — nothing runs until you wire it in `generators: [...]`.");
  lines.push("");

  const width = Math.max(...rows.map((r) => r.name.length));
  let layer: string | undefined;
  for (const r of rows) {
    if (r.layer !== layer) {
      layer = r.layer;
      lines.push(`${layer}  —  ${LAYER_BLURB[r.layer]}`);
    }
    const marks: string[] = [];
    if (r.framework !== undefined) marks.push(r.framework);
    if (r.tier === "neutral") marks.push("neutral");
    if (r.project?.wired) marks.push("WIRED");
    if (r.source.owned) marks.push("owned");
    if (probed && r.project?.wouldEmit !== null && r.project?.wouldEmit !== undefined) {
      marks.push(`would emit ${r.project.wouldEmit}`);
    }
    const suffix = marks.length > 0 ? `  [${marks.join(", ")}]` : "";
    lines.push(`  ${r.name.padEnd(width)}  —  ${r.description}${suffix}`);
    if (r.requires !== undefined && r.requires.length > 0) {
      lines.push(`  ${" ".repeat(width)}     requires: ${r.requires.join(", ")}`);
    }
  }

  lines.push("");
  lines.push("`meta eject <name...>` copies a generator into codegen/generators/ and prints");
  lines.push("the import to add, the entry to wire, and what to install.");
  if (!probed) {
    lines.push("Add --probe to see how many files each would emit for YOUR model.");
  }
  lines.push("`meta gen --list --format json` is the same catalog, machine-readable.");
  return lines.join("\n");
}
