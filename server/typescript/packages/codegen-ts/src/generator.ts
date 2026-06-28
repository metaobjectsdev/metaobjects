import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import type { RenderContext } from "./render-context.js";
import type { ResolvedGenConfig } from "./metaobjects-config.js";

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
  /** Marks the OPT-IN Hono routes generator (routesFileHono). The runner
   *  aggregates this across the active suite into `ctx.config.includeHonoRoutes`,
   *  so a generator that documents the API surface (api-docs) can AUTO-DETECT
   *  that Hono routes are actually being emitted and document them — rather than
   *  silently omitting the Hono CRUD registrars whenever the variant is wired. */
  emitsHonoRoutes?: boolean;
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
      const pkg = e.package ?? "";
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
