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
   *  aggregator), pattern C (mixed), pattern D (filter inline) all fit. */
  walk: (root: MetaRoot) => TemplateWalkResult[] | Promise<TemplateWalkResult[]>;
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
   *  generator resolves via `projectProvider(<projectRoot>)`, which layers
   *  the project's `templates/` over the framework defaults. (The project
   *  root is taken from `process.cwd()` at run time — adopters needing a
   *  different lookup chain can pass an explicit provider.) */
  provider?: Provider;
  /** Optional named target — same as the other generators. */
  target?: string;
}

export const templateGenerator = function templateGenerator(
  opts: TemplateGeneratorOpts,
): Generator {
  const fmt: TemplateFormat = opts.format ?? "text";
  const generator: Generator = {
    name: opts.name,
    async generate(ctx: GenContext): Promise<EmittedFile[]> {
      const provider = opts.provider ?? projectProvider(process.cwd());
      const walkRes = await opts.walk(ctx.loadedRoot);
      const files: EmittedFile[] = [];
      for (const { data, outputPath } of walkRes) {
        const content = render({
          ref: opts.template,
          payload: data,
          provider,
          format: fmt,
        });
        files.push({ path: outputPath, content });
      }
      return files;
    },
  };
  if (opts.filter) generator.filter = opts.filter;
  if (opts.target) generator.target = opts.target;
  return generator;
} as GeneratorFactory<TemplateGeneratorOpts>;
