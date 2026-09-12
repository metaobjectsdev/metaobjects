import type { MetaObject, MetaRoot, TypeRegistry } from "@metaobjectsdev/metadata";
import type { RenderContext } from "./render-context.js";
import type { ResolvedGenConfig } from "./metaobjects-config.js";
import type { OrphanPolicy } from "./reconcile-orphans.js";
import { effectivePackage } from "./docs-paths.js";

export interface EmittedFile {
  /** Path relative to ResolvedGenConfig.outDir. */
  path: string;
  /** Final TypeScript source (formatted by the generator itself). */
  content: string;
  /** Set by the runner from generator.name — generators should not set this. */
  generatedBy?: string;
}

export interface GenContext {
  entities: MetaObject[];
  loadedRoot: MetaRoot;
  /** Pre-composed by the runner from generator.filter (returns true when no
   *  filter is set). Always call this from helpers; do not call generator.filter
   *  directly. */
  matches: (entity: MetaObject) => boolean;
  /** FR-023 §11.1 item 2 — the model-wide output-scope predicate over a node's
   *  `resolutionKey()` (the runner's own `RunGenOpts.scope`, verbatim). A
   *  DIFFERENT knob from `matches`: `matches` is the per-generator `filter`
   *  (ANDed into what THIS generator emits), while `select` is the whole-model
   *  scope every generator shares — for a template that renders once over
   *  `ctx.loadedRoot` rather than per-entity (the shared-enums module is the
   *  first such template), `matches` never runs at all, so that template must
   *  read `select` directly to honour the same exclusion. Undefined ⇒ every
   *  node is in scope, byte-identical to a project with no `scope` declared. */
  select?: (fqn: string) => boolean;
  config: ResolvedGenConfig;
  /** Pre-built by the runner for built-in generators that wrap existing
   *  templates. Third-party generators typically don't need this. Always
   *  present at run time when invoked via runGen(); optional in the type
   *  so tests and custom callers don't need a placeholder. */
  renderContext?: RenderContext;
  /** Resolved absolute project root — what the runner derives from
   *  `opts.projectRoot` (the directory holding `.metaobjects/config.json`).
   *  Generators that resolve project-scoped resources (e.g.
   *  `templateGenerator` looking up the project's `templates/` directory)
   *  should read this rather than `process.cwd()`, which is whatever
   *  directory the CLI was invoked from and breaks when `meta gen` runs
   *  in a sub-directory. Undefined only when the runner was driven
   *  programmatically without an explicit projectRoot. */
  projectRoot?: string;
  /**
   * FR-023 §4.3 — the run's composed registry (core providers plus whatever this
   * project's `metaobjects.config.ts` `providers` adds), filled by the runner. The
   * SAME vocabulary `opts.metadata` was loaded with. `sharedModelFile()`'s
   * standalone re-loads of a `files` subset use this so a publisher project's own
   * consumer-supplied vocabulary is honoured identically to the main load. Optional
   * on the type so tests and custom callers don't need a placeholder; always
   * present at run time when invoked via `runGen()`.
   */
  registry?: TypeRegistry;
  /**
   * FR-023 §4.3 — the collection's own source files (never a dependency's
   * artifact), filled by the runner from `RunGenOpts.sourceFiles`. Distinct from
   * `loadedRoot`, which is already fully loaded and merged: `sharedModelFile()`
   * needs the raw file LIST so it can re-load a `files:`-narrowed subset of it
   * standalone. Undefined when the caller never supplied `RunGenOpts.sourceFiles`
   * (a generator relying on it should default sensibly, as `sharedModelFile()`'s
   * own `files` option does).
   */
  sourceFiles?: readonly string[];
  warn: (msg: string) => void;
}

export interface Generator {
  /** kebab-case identifier; surfaces in diagnostics + drift logs. */
  name: string;
  /** Optional per-entity filter applied via ctx.matches inside generate(). */
  filter?: (entity: MetaObject) => boolean;
  generate: (ctx: GenContext) => EmittedFile[] | Promise<EmittedFile[]>;
  /** Named output target (registry key). Defaults to "default". */
  target?: string;
  /** Marks the generator that produces entity modules — the runner uses its
   *  target as the entity-module target for cross-target import resolution. */
  emitsEntityModule?: boolean;
  /** FR-038 §8 — OPT IN to orphan reconciliation by declaring the output
   *  namespace this generator exclusively owns. When set, the runner removes
   *  files inside that namespace which a previous run generated and this run did
   *  not, REFUSING any that have been edited by hand. Absent (the default for
   *  every existing generator) means the runner never deletes anything, which is
   *  why this is additive: output stops being generated and the stale file simply
   *  stays, exactly as before. */
  orphanPolicy?: OrphanPolicy;
  /** Marks the OPT-IN Hono routes generator (routesFileHono). The runner
   *  aggregates this across the active suite into `ctx.config.includeHonoRoutes`,
   *  so a generator that documents the API surface (api-docs) can AUTO-DETECT
   *  that Hono routes are actually being emitted and document them — rather than
   *  silently omitting the Hono CRUD registrars whenever the variant is wired. */
  emitsHonoRoutes?: boolean;
  /** §A6 — marks the generator that emits the <Entity>Names artifact. The runner
   *  aggregates this across the suite into ResolvedGenConfig.includeNames, which the
   *  entity generator reads to decide whether it may reference those constants.
   *  Same mechanism as emitsHonoRoutes/includeHonoRoutes. */
  emitsNames?: boolean;
  /** Marks a generator that emits a CLIENT UI artifact — a form, a hook, a grid or
   *  its columns. The runner aggregates it across the suite into
   *  ResolvedGenConfig.includeUiTier, which `agent/ui.md` reads to decide whether
   *  there is a UI tier to describe at all.
   *
   *  This exists because the page's gate was metadata-only (`servesReadApi`), which
   *  answers "could a UI be generated for this object?" and never "does this run
   *  generate one?". A project with `generators: []` got a confident page naming
   *  endpoints nothing serves and forms nothing emits — to an audience explicitly
   *  told to read it BEFORE touching a tier. Whether an artifact exists is a
   *  GENERATOR fact; no metadata predicate can answer it.
   *
   *  Run-scoped, like emitsHonoRoutes and unlike emitsNames: the page asks "is this
   *  surface in the run?", not "does it land in my target?". */
  emitsUiTier?: boolean;
}

export type GeneratorFactory<TOpts = void> = TOpts extends void
  ? () => Generator
  : (opts?: TOpts) => Generator;

/** One-file-per-entity convenience. Async-safe. */
export function perEntity(
  fn: (entity: MetaObject, ctx: GenContext) =>
    | EmittedFile
    | EmittedFile[]
    | Promise<EmittedFile | EmittedFile[]>,
): (ctx: GenContext) => Promise<EmittedFile[]> {
  return async (ctx) => {
    const matched = ctx.entities.filter(ctx.matches);
    const results = await Promise.all(matched.map((e) => fn(e, ctx)));
    return results.flatMap((r) => (Array.isArray(r) ? r : [r]));
  };
}

/** Called once with all matching entities. Use for barrels and cross-entity files.
 *  @deprecated Use {@link perModel} — "run" is ambiguous under multi-target output
 *  (it reads as "per target"); `perModel` names the data scope (the whole model). */
export function oncePerRun(
  fn: (entities: MetaObject[], ctx: GenContext) =>
    | EmittedFile
    | EmittedFile[]
    | Promise<EmittedFile | EmittedFile[]>,
): (ctx: GenContext) => Promise<EmittedFile[]> {
  return async (ctx) => {
    const matched = ctx.entities.filter(ctx.matches);
    const result = await fn(matched, ctx);
    return Array.isArray(result) ? result : [result];
  };
}

/** App-scope convenience — run `fn` once over the whole model (all matched
 *  entities). The canonical name for the one-shot scope (replaces `oncePerRun`). */
export const perModel = oncePerRun;

/** One-file-per-package convenience. Groups matched entities by `package`, runs
 *  `fn` once per package — packages ascending, entities keeping `ctx.entities`
 *  order. The package scope from codegen-concepts §10 (object + model already
 *  exist via perEntity + perModel). */
export function perPackage(
  fn: (pkg: string, entities: MetaObject[], ctx: GenContext) =>
    | EmittedFile
    | EmittedFile[]
    | Promise<EmittedFile | EmittedFile[]>,
): (ctx: GenContext) => Promise<EmittedFile[]> {
  return async (ctx) => {
    const matched = ctx.entities.filter(ctx.matches);
    const byPkg = new Map<string, MetaObject[]>();
    for (const e of matched) {
      const pkg = effectivePackage(e) ?? "";
      let bucket = byPkg.get(pkg);
      if (bucket === undefined) { bucket = []; byPkg.set(pkg, bucket); }
      bucket.push(e);
    }
    const out: EmittedFile[] = [];
    for (const pkg of [...byPkg.keys()].sort()) {
      const r = await fn(pkg, byPkg.get(pkg)!, ctx);
      out.push(...(Array.isArray(r) ? r : [r]));
    }
    return out;
  };
}
