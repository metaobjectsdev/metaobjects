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
  warn: (msg: string) => void;
}

export interface Generator {
  /** kebab-case identifier; surfaces in diagnostics + drift logs. */
  name: string;
  /** Optional per-entity filter applied via ctx.matches inside generate(). */
  filter?: (entity: MetaObject) => boolean;
  generate: (ctx: GenContext) => EmittedFile[] | Promise<EmittedFile[]>;
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

/** Called once with all matching entities. Use for barrels and cross-entity files. */
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
