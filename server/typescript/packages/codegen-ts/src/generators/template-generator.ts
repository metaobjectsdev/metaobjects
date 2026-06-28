// templateGenerator() — the missing primitive identified by the
// template-driven-codegen design (2026-05-28). Walks the loaded MetaRoot
// → renders shared Mustache templates via @metaobjectsdev/render → emits
// EmittedFile[]. Same Generator interface as the per-port hand-coded
// generators; just adds the "Mustache template" + "walk that yields a
// data dict per output" primitives.
//
// Design line we adopted (from the design doc):
//   Code → hand-coded generators (ts-poet, idiomatic per-port).
//   Documents → templateGenerator (shared Mustache templates).
//
// docsFile() is the first templateGenerator instance (rc.12). OpenAPI specs,
// Mermaid diagrams, HTML doc sites, etc. follow as templates + a walk
// function each.

import type { MetaRoot, MetaObject } from "@metaobjectsdev/metadata";
import { render, type Provider, type RenderFormat } from "@metaobjectsdev/render";
import type { Generator, GenContext, EmittedFile, GeneratorFactory } from "../generator.js";
import { projectProvider } from "../render-engine/framework-provider.js";
import { expandOutputPattern } from "../template-codegen/output-pattern.js";
import {
  buildEntityTemplateData,
  buildPackageTemplateData,
  buildModelTemplateData,
  packageOf,
} from "../template-codegen/template-data.js";

/** The three built-in walk scopes (SP-1 §3.1). Same vocabulary as the engine
 *  helpers perEntity/perPackage/perModel. */
export type TemplateScope = "perEntity" | "perPackage" | "perModel";

export type TemplateFormat = RenderFormat;

export interface TemplateWalkResult {
  /** The data dict to render against. Templates reference its keys; the
   *  shape is the public-API contract template authors consume. */
  data: object;
  /** Output path RELATIVE to the generator's target outDir. */
  outputPath: string;
}

export interface TemplateGeneratorOpts {
  /** kebab-case identifier; surfaces in diagnostics and the overwrite-policy
   *  per-file snapshot key. */
  name: string;
  /** Walk the loaded metadata tree and produce `{ data, outputPath }` tuples
   *  — one per emitted file. Pattern A (per-entity), pattern B (single
   *  aggregator), pattern C (mixed), pattern D (filter inline) all fit.
   *  Mutually exclusive with `scope` — provide exactly one. The power-user
   *  escape hatch; most consumers declare a `scope` + `outputPattern` instead. */
  walk?: (root: MetaRoot) => TemplateWalkResult[] | Promise<TemplateWalkResult[]>;
  /** Built-in walk scope (SP-1 §3.1) — declarative alternative to `walk`. The
   *  generator derives the neutral data dict (template-data.ts) per unit and
   *  names each file via `outputPattern`. Mutually exclusive with `walk`. */
  scope?: TemplateScope;
  /** Output path pattern for the built-in `scope` walk: `{name}` `{Name}`
   *  `{package}` (SP-1 §3.3). Required with `scope`; ignored with `walk`. */
  outputPattern?: string;
  /** Template reference. Resolved by the configured Provider chain — by
   *  default the project's `templates/<ref>.mustache` first, then the
   *  framework defaults at `codegen-ts/templates/<ref>.mustache`. */
  template: string;
  /** Drives the render engine's escaper. Defaults to "text". */
  format?: TemplateFormat;
  /** Optional per-entity filter for adopters who want to scope a generator
   *  via the standard `Generator.filter` plumbing. Not consulted by the
   *  default `walk` — adopters apply filters inside their walk function. */
  filter?: (entity: MetaObject) => boolean;
  /** Override the Provider used for template resolution. When omitted the
   *  generator resolves via `projectProvider(ctx.projectRoot)`, which layers
   *  the project's `templates/` over the framework defaults. (The project
   *  root is the directory holding `.metaobjects/config.json`, threaded
   *  through `GenContext` by the runner. Adopters needing a different
   *  lookup chain can pass an explicit provider.) */
  provider?: Provider;
  /** Optional named target — same as the other generators. */
  target?: string;
}

/** Derive a `walk` from a built-in scope + output pattern. Each scope yields the
 *  neutral data dict for its unit and names the file via the pattern. */
function scopeWalk(
  scope: TemplateScope,
  pattern: string,
): (root: MetaRoot) => TemplateWalkResult[] {
  return (root) => {
    const concrete = root.objects().filter((o) => o.isAbstract !== true);
    if (scope === "perEntity") {
      return concrete.map((e) => ({
        data: buildEntityTemplateData(e),
        outputPath: expandOutputPattern(pattern, { name: e.name, package: packageOf(e) }),
      }));
    }
    if (scope === "perPackage") {
      const byPkg = new Map<string, MetaObject[]>();
      for (const o of concrete) {
        const pkg = packageOf(o);
        let bucket = byPkg.get(pkg);
        if (bucket === undefined) { bucket = []; byPkg.set(pkg, bucket); }
        bucket.push(o);
      }
      return [...byPkg.keys()].sort().map((pkg) => ({
        data: buildPackageTemplateData(pkg, byPkg.get(pkg)!),
        outputPath: expandOutputPattern(pattern, { package: pkg }),
      }));
    }
    // perModel — one file over the whole model.
    return [{ data: buildModelTemplateData(root), outputPath: expandOutputPattern(pattern, {}) }];
  };
}

export const templateGenerator = function templateGenerator(
  opts: TemplateGeneratorOpts,
): Generator {
  const fmt: TemplateFormat = opts.format ?? "text";
  const hasWalk = typeof opts.walk === "function";
  const hasScope = opts.scope !== undefined;
  if (hasWalk === hasScope) {
    throw new Error(
      `templateGenerator(${opts.name}): provide exactly one of \`walk\` or (\`scope\` + \`outputPattern\`)`,
    );
  }
  if (hasScope && (opts.outputPattern === undefined || opts.outputPattern === "")) {
    throw new Error(`templateGenerator(${opts.name}): \`scope\` requires a non-empty \`outputPattern\``);
  }
  const walk = hasWalk ? opts.walk! : scopeWalk(opts.scope!, opts.outputPattern!);
  const generator: Generator = {
    name: opts.name,
    async generate(ctx: GenContext): Promise<EmittedFile[]> {
      let provider: Provider;
      if (opts.provider !== undefined) {
        provider = opts.provider;
      } else if (ctx.projectRoot !== undefined) {
        provider = projectProvider(ctx.projectRoot);
      } else {
        ctx.warn(
          "templateGenerator: ctx.projectRoot is undefined; falling back to process.cwd() for project-template resolution. " +
          "Project-scoped template overrides will resolve relative to the current working directory, which is fragile under " +
          "`meta gen` invoked from a sub-directory. Drive via runGen(opts.projectRoot) to remove this warning.",
        );
        provider = projectProvider(process.cwd());
      }
      const walkRes = await walk(ctx.loadedRoot);
      const files: EmittedFile[] = [];
      for (const { data, outputPath } of walkRes) {
        let content: string;
        try {
          content = render({
            ref: opts.template,
            payload: data,
            provider,
            format: fmt,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `templateGenerator(${opts.name}) failed rendering '${opts.template}' for '${outputPath}': ${msg}`,
            { cause: err instanceof Error ? err : undefined },
          );
        }
        files.push({ path: outputPath, content });
      }
      return files;
    },
  };
  if (opts.filter) generator.filter = opts.filter;
  if (opts.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<TemplateGeneratorOpts>;
