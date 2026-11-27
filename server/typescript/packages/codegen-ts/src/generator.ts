import type { SchemaBuildSettings } from "@metaobjectsdev/migrate-ts";
import type { ExposeOption } from "./routes-expose.js";
import type { MetaDataTypeProvider, MetaObject, MetaRoot, TypeRegistry } from "@metaobjectsdev/metadata";
import type { LibraryManifest } from "@metaobjectsdev/metadata/library";
import type { RenderContext } from "./render-context.js";
import type { DocsRunFacts } from "./docs-run.js";
import type { ResolvedGenConfig } from "./metaobjects-config.js";
import type { OrphanPolicy } from "./reconcile-orphans.js";
import type { HandEdits } from "./overwrite-policy.js";
import { effectivePackage } from "./docs-paths.js";

export interface EmittedFile {
  /** Path relative to ResolvedGenConfig.outDir. */
  path: string;
  /** The file's final contents, in any format — TypeScript, JSON, YAML, SQL, Markdown.
   *  The runner writes it as given: it neither formats it nor adds a header, so a
   *  generator that wants a header does it itself (`GENERATED_HEADER`). */
  content: string;
  /** Set by the runner from generator.name — generators should not set this. */
  generatedBy?: string;
  /** The resolution key of the metadata node this file was rendered from
   *  (`acme::shop::Order`), recorded beside the file's hash in the manifest under `.gen-state/.hashes/`.
   *  `perEntity` sets it for you; a generator rendering one file from one node by other
   *  means sets it itself. Leave it unset for a file rendered from the whole model or a
   *  whole package (a barrel, a docs index). */
  sourceNode?: string;
}

export interface GenContext {
  /** Every object the run generates for: the WHOLE model (after the project's `scope`),
   *  even when `meta gen <Entity>` names some of them. A file rendered from the whole
   *  model — a barrel, an index, a shared schema — reads this and so never shrinks to
   *  the named entities. A per-entity file honours `selected` as well. */
  entities: MetaObject[];
  /** The objects `meta gen <Entity>` named, as a predicate. Undefined ⇒ every object
   *  in `entities` is selected. `perEntity` applies it for you; a generator that emits
   *  one file per object by other means applies it itself, and one that renders a
   *  single file from the whole model ignores it. */
  selected?: (entity: MetaObject) => boolean;
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
  /** FR-023 — is the requirement at `<package>::<dotted path>` part of this project's ledger
   *  (`RunGenOpts.inLedger`, the collection's `inLedger`)? A dependency's requirement the
   *  project did not inherit is loaded and gets no generated test. Undefined ⇒ every loaded
   *  requirement is the project's, as before the option existed. */
  inLedger?: (fqn: string) => boolean;
  config: ResolvedGenConfig;
  /** Pre-built by the runner: the resolved config keys that are not on `config` —
   *  `apiPrefix`, `columnNamingStrategy`, `collectionName`, `timestampMode` — plus the
   *  precomputed pk/relation maps the built-in templates use. A generator of your own
   *  reads it for those keys (`ctx.renderContext?.apiPrefix ?? ""`). Always present at
   *  run time when invoked via runGen(); optional in the type so tests and custom
   *  callers don't need a placeholder. */
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
  /**
   * The collection's metadata source DIRECTORIES, with the directory of each dependency's
   * artifact, filled by the runner from `RunGenOpts.sourceRoots`. For a generator that loads
   * the model with a loader of its own, one page group per directory (`docsSiteFile()`).
   * Undefined when the caller never supplied them.
   */
  sourceRoots?: readonly string[];
  /**
   * The project's own metamodel providers (`providers` in metaobjects.config.ts), for a
   * generator that loads the model with a loader of its own, so it resolves the same
   * vocabulary the run's model was loaded with. Undefined when the project declares none.
   */
  providers?: readonly MetaDataTypeProvider[];
  /**
   * FR-043 §6 — the manifests of the libraries this project opted into, filled by the
   * runner from `RunGenOpts.libraries`.
   *
   * What a generator reads it FOR is the `anchor`: the library node it keys on. That
   * retires the hard-coded entity name a library-aware generator would otherwise carry
   * (`trace-helper` compared `.name === "LlmCallBase"`, so ANY adopter entity of that
   * name in ANY package triggered it) in favour of resolving the manifest's anchor to a
   * node and comparing by node identity.
   *
   * Undefined means the caller never said — a programmatic `runGen()` rather than
   * `meta gen`. A generator reading it should fall back to every SHIPPED manifest's
   * anchors, which is still FQN-anchored and still not a bare name. An empty array is
   * the opposite and is meaningful: the caller looked, and this project opted into none.
   */
  libraries?: readonly LibraryManifest[];
  /**
   * The real project directory, for a generator that READS the project's own files: the
   * nearest `package.json`, a version file, anything it resolves against the project. Under
   * `meta gen` it is `projectRoot`. Under `meta verify --codegen` the run writes into a
   * throwaway tree, `projectRoot` is that tree (import paths between an output directory
   * and the project are computed against it, so it has to mirror the layout), and this is
   * the project the tree mirrors. Read files through this (a docs generator's template
   * overrides included); compute output-relative paths against `projectRoot`. Undefined when
   * the caller supplied neither root.
   */
  inputRoot?: string;
  /**
   * What the documentation pages in this generator's target must agree on, built by the
   * runner from the generators the run declares (ADR-0034 Amendment 9): which api reference
   * pages sit beside the model pages, whether the model pages are there to link back to, and
   * the physical schema `agent/schema.md` describes. Absent on a direct `.generate(ctx)`
   * call, where a docs generator's own options decide. See docs-run.ts.
   */
  docs?: DocsRunFacts;
  /**
   * The project's schema settings for a generator that builds the expected physical schema
   * (the Prisma schema): `migrate.conventions` and `migrate.checks` from .metaobjects/config.json,
   * or a conventions object from metaobjects.config.ts, resolved by the caller. Absent: the
   * default conventions, every CHECK.
   */
  schemaSettings?: SchemaBuildSettings;
  /**
   * The files this run generated, for a generator marked `readsRunOutput` (the docs site's
   * model explorer, which lists what was generated from each node). The runner runs such a
   * generator after every other one, so the list is complete. Paths are project-relative,
   * as the manifest under `.gen-state/.hashes/` keys them. A run narrowed with `--generators` adds the
   * files the committed manifest records for the generators it did not run, so a narrowed
   * run lists what a full run lists. Absent for a generator without the marker.
   */
  runOutput?: () => readonly RunOutputFile[];
  /**
   * The requirement ledger as `meta verify --format json` states it (`requirementLedger`,
   * `requirementCounts`, `requirements.rows`), computed by the caller that owns the
   * requirement gate (`meta gen`, `meta verify --codegen`), which codegen-ts cannot import.
   * Called at most once per run, and only when a generator asks. Absent when the caller
   * supplied none; returns undefined when the model declares no requirement.
   */
  requirementLedger?: () => unknown;
  /**
   * The run's one claim registry: claim a name as it is emitted into a shared scope. The first
   * claimant owns it; another claimant of the same name in the same scope is refused
   * (`ERR_NAME_COLLISION`), naming both and `remedy`. The same claimant claiming again is not a
   * collision, and one name in two scopes is two names. Shared by every generator of a `runGen`;
   * absent on a direct `.generate(ctx)` call, where nothing is claimed. The helpers in
   * `naming/name-claims.ts` claim the names the reference generators emit.
   */
  claim?: (scope: string, name: string, claimant: string, remedy: string) => void;
  /** This generator's entry in the run's list, `#n`: for a scope that is one entry's own (a
   *  routes entry's segments). Absent outside `runGen`. */
  entryLabel?: string;
  warn: (msg: string) => void;
}

/** What `Generator.checkRunOutput` is given. Paths are absolute, as the runner writes them. */
export interface RunOutputCheck {
  /** The files this generator emitted, in its order. */
  own: readonly { fullPath: string; content: string }[];
  /** A file's text: this run's output when it emitted the path, else the file on disk, else
   *  `undefined`. A run narrowed with `--generators` reads the rest of the site from disk. */
  read: (fullPath: string) => string | undefined;
}

/** One file of the run, as `GenContext.runOutput` lists it. */
export interface RunOutputFile {
  /** Project-relative path, `/`-separated. */
  path: string;
  generatedBy: string;
  /** The node the file was rendered from (`EmittedFile.sourceNode`), when it was. */
  sourceNode?: string;
}

export interface Generator {
  /** kebab-case identifier; surfaces in diagnostics + drift logs. */
  name: string;
  /** Optional per-entity filter applied via ctx.matches inside generate(). */
  filter?: (entity: MetaObject) => boolean;
  generate: (ctx: GenContext) => EmittedFile[] | Promise<EmittedFile[]>;
  /**
   * What this generator provides that another part of the run asks about (ADR-0034 Amendment
   * 12): the entity modules, the query modules, the routes it mounts, the docs pages. The runner,
   * the docs generators and the gates read this one declaration through {@link providesOf} and
   * never a generator's name, so a generator of your own that declares the same thing is seen the
   * same way. Leave it out when your generator provides none of these.
   */
  provides?: GeneratorProvides;
  /** Named output target (registry key). Defaults to "default". */
  target?: string;
  /** Marks the generator that produces entity modules — the runner uses its
   *  target as the entity-module target for cross-target import resolution, and
   *  aggregates it into `ctx.config.includeEntityModule`, which the api reference reads
   *  to document the model, its Zod schemas and its `relations()` only when something
   *  emits them. A copy ejected before the marker is matched by its name. *
   *  @deprecated Declare `provides: { entityModule: true }` instead (ADR-0034 Amendment 12). Still read, through
   *  {@link providesOf}, so an owned copy that sets it keeps working. */
  emitsEntityModule?: boolean;
  /** FR-038 §8 — declare the output namespace this generator exclusively owns.
   *  A full `meta gen` run already removes every file it recorded writing in a
   *  target directory and no generator emits any more, refusing any edited by hand
   *  (the run-wide sweep, every generator, no opt-in). A policy adds two things on
   *  top: its namespace is still reconciled on a `--generators` run that names this
   *  generator, and `force` can delete a hand-edited file in it instead of refusing. */
  orphanPolicy?: OrphanPolicy;
  /**
   * What a hand edit to one of this generator's files gets. `"keep"`, the default,
   * protects it: the edit is merged into fresh output when this machine has a snapshot
   * body, and the file is refused by name otherwise; an edited file no generator emits
   * any more is refused, not deleted. `"overwrite"` discards it: the file is replaced
   * with fresh output and its record re-baselined, and an edited file of this generator's
   * that no generator emits any more is deleted. Each discarded edit is named in the
   * run's warnings. A file `gen` has no record of writing is never touched either way.
   * The same setting, by the same name, exists in every port.
   */
  handEdits?: HandEdits;
  /**
   * ADR-0064 — `false` when this generator reads something `meta gen` cannot fingerprint
   * (the network, an environment variable, a file it cannot name in advance). A run that
   * includes it never skips. Default `true`: what a generator reads from the model, its
   * options, the config and the project's `templates/` and `codegen/` directories is
   * already in the fingerprint.
   */
  cache?: boolean;
  /**
   * ADR-0064 — further files or directories this generator reads, relative to the project
   * root (a directory counts every file under it). Their contents join the fingerprint, so
   * editing one makes the next `meta gen` regenerate instead of skipping.
   */
  inputs?: readonly string[];
  /**
   * ADR-0064 — `true` when this generator reads the raw metadata source files beside the
   * loaded model (their comments, say), which the model hash does not carry. The files under
   * the run's metadata source roots join the fingerprint, so a comment-only edit makes the
   * next `meta gen` regenerate instead of skipping.
   */
  readsMetadataSources?: boolean;
  /** Marks the OPT-IN Hono routes generator (routesFileHono). The runner
   *  aggregates this across the active suite into `ctx.config.includeHonoRoutes`,
   *  so a generator that documents the API surface (api-docs) can AUTO-DETECT
   *  that Hono routes are actually being emitted and document them — rather than
   *  silently omitting the Hono CRUD registrars whenever the variant is wired. *
   *  @deprecated Declare `provides: { routes: { framework: "hono" } }` instead (ADR-0034 Amendment 12). Still read, through
   *  {@link providesOf}, so an owned copy that sets it keeps working. */
  emitsHonoRoutes?: boolean;
  /** Marks a generator that mounts the CRUD routes (`routesFile`, `routesFileHono`) and carries
   *  the `expose` option it was built with. The runner aggregates it across the suite
   *  (`runRoutesExpose`), per surface (a `emitsHonoRoutes` generator is the Hono one), so the API docs list the verbs each routes file actually mounts, not all five.
   *  Absent `expose` means every verb. A copy ejected before this marker existed needs
   *  `meta eject routes --force` (or the same one-line addition) to be honoured. *
   *  @deprecated Declare `provides: { routes: { framework, expose, filter } }` instead (ADR-0034 Amendment 12). Still read, through
   *  {@link providesOf}, so an owned copy that sets it keeps working. */
  mountsRoutes?: {
    readonly expose?: ExposeOption;
    /** The generator's own `filter` option (not its built-in gates): an entity it rejects is
     *  mounted nowhere, so the API docs list none of its routes. */
    readonly filter?: (entity: MetaObject) => boolean;
  };
  /** Marks a generator that writes the per-object model pages and their index (`docsFile()`).
   *  The runner reads it, per target, to tell an api reference generator in the same target
   *  that there are model pages to link back to (`ctx.docs.modelPages`). It changes nothing
   *  about whether or where this generator runs: the list decides that, as for every
   *  generator (ADR-0034 Amendment 9). An owned copy keeps it. *
   *  @deprecated Declare `provides: { modelDocs: true }` instead (ADR-0034 Amendment 12). Still read, through
   *  {@link providesOf}, so an owned copy that sets it keeps working. */
  emitsModelDocs?: boolean;
  /** Marks a generator that writes the api reference pages (`apiDocsFile()`), with the
   *  directory under its target they go in. The runner reads it, per target, so the model
   *  pages in the same target link to them (`ctx.docs.apiSurfaces`). Like `emitsModelDocs`,
   *  a cross-link fact only. *
   *  @deprecated Declare `provides: { apiDocs: { subDir } }` instead (ADR-0034 Amendment 12). Still read, through
   *  {@link providesOf}, so an owned copy that sets it keeps working. */
  emitsApiDocs?: { readonly subDir: string };
  /** Marks a generator that reads the files the rest of the run generated
   *  (`ctx.runOutput`). The runner runs every marked generator after every unmarked one,
   *  in declared order, so the list it reads is complete. */
  readsRunOutput?: boolean;
  /**
   * A check over the run's output, called once after EVERY selected generator has run and
   * before anything is written, so it sees the files the generators after this one emit too.
   * It returns one message per problem; any message fails the run, naming this generator, and
   * nothing is written. The template generator's `linkCheck` is one: every relative link in its
   * pages must land on a file and an anchor this run (or the disk) holds.
   */
  checkRunOutput?: (run: RunOutputCheck) => readonly string[];
  /** §A6 — marks the generator that emits the <Entity>Names artifact. The runner
   *  aggregates this across the suite into ResolvedGenConfig.includeNames, which the
   *  entity generator reads to decide whether it may reference those constants.
   *  Same mechanism as emitsHonoRoutes/includeHonoRoutes. *
   *  @deprecated Declare `provides: { names: true }` instead (ADR-0034 Amendment 12). Still read, through
   *  {@link providesOf}, so an owned copy that sets it keeps working. */
  emitsNames?: boolean;
  /** Marks the `report-export` generator. The runner aggregates it, per target (as `emitsNames`),
   *  into `ctx.config.includeReportExport` / `RenderContext.includeReportExport`, which the routes
   *  generators read to emit the `format` branch on a report list route. Without a marked
   *  generator in the route file's target the routes are byte-identical to before export existed. *
   *  @deprecated Declare `provides: { reportExport: true }` instead (ADR-0034 Amendment 12). Still read, through
   *  {@link providesOf}, so an owned copy that sets it keeps working. */
  emitsReportExport?: boolean;
  /** Marks the generator that writes the `<Entity>.queries.ts` data-access modules
   *  (`queriesFile()`). The runner aggregates it across the run into
   *  `ctx.config.includeQueries`, which the api reference reads to document the query helpers
   *  only when something emits them. A copy ejected before the marker is matched by its name. *
   *  @deprecated Declare `provides: { queries: true }` instead (ADR-0034 Amendment 12). Still read, through
   *  {@link providesOf}, so an owned copy that sets it keeps working. */
  emitsQueries?: boolean;
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
   *  surface in the run?", not "does it land in my target?". *
   *  @deprecated Declare `provides: { uiTier: true }` instead (ADR-0034 Amendment 12). Still read, through
   *  {@link providesOf}, so an owned copy that sets it keeps working. */
  emitsUiTier?: boolean;
}

/**
 * The one declaration of what a generator provides (ADR-0034 Amendment 12). Each key is a fact
 * another part of the run reads; a key left out is "not provided".
 */
export interface GeneratorProvides {
  /** The entity modules (`<Entity>.ts`: the model, its Zod schemas and its `relations()`). The
   *  runner takes this generator's target as the entity-module target for cross-target imports,
   *  and the api reference documents the model only when something provides it. */
  readonly entityModule?: boolean;
  /** The `<Entity>.queries.ts` data-access modules. The api reference documents the query
   *  helpers only when something provides them. */
  readonly queries?: boolean;
  /** The `<Entity>Names` artifact, per target. The entity modules in the same target reference
   *  its constants only when it is there. */
  readonly names?: boolean;
  /** The report export writers, per target. The routes in the same target mount a report list
   *  route's `format` branch only when they are there. */
  readonly reportExport?: boolean;
  /** The CRUD routes it mounts, on which framework, with the `expose` and `filter` options it was
   *  built with: the api reference lists the verbs each surface mounts (absent `expose` means all
   *  five; an entity `filter` rejects is mounted nowhere). */
  readonly routes?: GeneratorRoutes;
  /** A client UI artifact: a form, a hook, a grid or its columns. `agent/ui.md` describes a UI
   *  tier only when the run provides one. */
  readonly uiTier?: boolean;
  /** The per-object model pages and their index. An api reference in the same target links to
   *  them. */
  readonly modelDocs?: boolean;
  /** The api reference pages, in `subDir` under the generator's target. The model pages in the
   *  same target link to them. */
  readonly apiDocs?: { readonly subDir: string };
}

/** The routes a generator mounts, as {@link GeneratorProvides.routes} declares them. */
export interface GeneratorRoutes {
  /** The routes surface: the Fastify REST routes or the opt-in Hono routes. */
  readonly framework: "fastify" | "hono";
  readonly expose?: ExposeOption;
  /** The generator's own `filter` option (not its built-in gates). */
  readonly filter?: (entity: MetaObject) => boolean;
}

/**
 * What a generator provides: its {@link Generator.provides} declaration, with the deprecated
 * single-purpose markers an owned copy ejected before the declaration still sets folded in. The
 * one reader of both; every consumer asks this.
 */
export function providesOf(g: Generator): GeneratorProvides {
  const p = g.provides ?? {};
  const legacyRoutes: GeneratorRoutes | undefined =
    g.mountsRoutes !== undefined || g.emitsHonoRoutes === true
      ? {
          framework: g.emitsHonoRoutes === true ? "hono" : "fastify",
          ...(g.mountsRoutes?.expose !== undefined && { expose: g.mountsRoutes.expose }),
          ...(g.mountsRoutes?.filter !== undefined && { filter: g.mountsRoutes.filter }),
        }
      : undefined;
  const routes = p.routes ?? legacyRoutes;
  const apiDocs = p.apiDocs ?? g.emitsApiDocs;
  return {
    entityModule: p.entityModule === true || g.emitsEntityModule === true,
    queries: p.queries === true || g.emitsQueries === true,
    names: p.names === true || g.emitsNames === true,
    reportExport: p.reportExport === true || g.emitsReportExport === true,
    uiTier: p.uiTier === true || g.emitsUiTier === true,
    modelDocs: p.modelDocs === true || g.emitsModelDocs === true,
    ...(routes !== undefined && { routes }),
    ...(apiDocs !== undefined && { apiDocs }),
  };
}

export type GeneratorFactory<TOpts = void> = TOpts extends void
  ? () => Generator
  : (opts?: TOpts) => Generator;

/** The objects this run generates for: `ctx.entities` narrowed by `ctx.matches` and the
 *  `meta gen <Entity>` selection. The one predicate every per-object emitter applies. */
export function selectedEntities(ctx: GenContext): MetaObject[] {
  return ctx.entities.filter((e) => ctx.matches(e) && (ctx.selected?.(e) ?? true));
}

/** One-file-per-entity convenience. Async-safe. */
export function perEntity(
  fn: (entity: MetaObject, ctx: GenContext) =>
    | EmittedFile
    | EmittedFile[]
    | Promise<EmittedFile | EmittedFile[]>,
): (ctx: GenContext) => Promise<EmittedFile[]> {
  return async (ctx) => {
    const matched = selectedEntities(ctx);
    const results = await Promise.all(matched.map(async (e) => {
      const r = await fn(e, ctx);
      // Each file names the object it was rendered from, unless the generator said
      // otherwise — so every per-entity generator, owned copies included, records its
      // provenance without a line of its own.
      const key = e.resolutionKey();
      return (Array.isArray(r) ? r : [r]).map((f) => (f.sourceNode !== undefined ? f : { ...f, sourceNode: key }));
    }));
    return results.flat();
  };
}

/** Called once with all matching entities of the whole model, whatever `meta gen <Entity>`
 *  named. Use for barrels and cross-entity files.
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
