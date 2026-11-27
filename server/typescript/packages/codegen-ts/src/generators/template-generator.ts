// templateGenerator() — the missing primitive identified by the
// template-driven-codegen design (2026-05-28). Walks the loaded MetaRoot
// → renders shared Mustache templates via @metaobjectsdev/render → emits
// EmittedFile[]. Same Generator interface as the per-port hand-coded
// generators; just adds the "Mustache template" + "walk that yields a
// data dict per output" primitives.
//
// SUPERSEDED, and left here as a correction because the old line still circulates:
// the original 2026-05-28 split was "Code → hand-coded generators, Documents →
// templateGenerator", with code emission an explicit NON-GOAL for this primitive.
// SP-1 (docs/superpowers/specs/2026-06-28-mustache-codegen-parity-design.md §2)
// moved past it — its goal is a consumer authoring "a working code generator, on ANY
// port, with NO generator code", and its worked outputPattern is
// "{package}/{name}Service.java". Source, not a document.
//
// The axis is NOT what kind of file comes out. It is: pick a template when the output
// SHAPE is what you are iterating on, or when you want the same output across
// languages (that is what the neutral data dict buys); pick a hand-coded generator
// when the logic is gnarly or the run is hot. Tradeoff table:
// docs/features/codegen-concepts.md §3.
//
// This matters most where a port has no choice: C# and Python expose closed built-in
// generator registries, so the declarative spec is the ONLY consumer authoring path
// there — and a documents-only reading of this primitive would tell those adopters
// their port cannot emit a custom shape at all.
//
// docsFile() is the first templateGenerator instance (rc.12), which is why the
// documents framing stuck; it is the first instance, not the boundary.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { REQUIREMENT, type MetaRoot, type MetaObject, type DocsView } from "@metaobjectsdev/metadata";
import { render, type Provider, type RenderFormat } from "@metaobjectsdev/render";
import { findDanglingLinks } from "@metaobjectsdev/docs-site";
import type { Generator, GenContext, EmittedFile, GeneratorFactory, RunOutputCheck } from "../generator.js";
import { projectProvider } from "../render-engine/framework-provider.js";
import { expandOutputPattern } from "../template-codegen/output-pattern.js";
import {
  buildEntityTemplateData,
  buildPackageTemplateData,
  buildModelTemplateData,
  packageOf,
} from "../template-codegen/template-data.js";
import { runDocsView } from "../docs-view-run.js";

/** The built-in walk scopes (SP-1 §3.1). `perEntity`, `perPackage` and `perModel` are the same
 *  vocabulary as the engine helpers; `perNode` and `perRequirement` walk the docs view
 *  (`docs/features/docs-view.md`): one file per top-level node of any type, and one per
 *  requirement at any depth. */
export type TemplateScope = "perEntity" | "perPackage" | "perModel" | "perNode" | "perRequirement";

/** What a template reads. `entities`, the default for the first three scopes, is the neutral
 *  per-entity dictionary (`template-data.ts`). `docsView` is the docs view, the data of
 *  `perNode` and `perRequirement` and an opt-in for `perPackage` and `perModel`. */
export type TemplateData = "entities" | "docsView";

export type TemplateFormat = RenderFormat;

/** A directory of static files copied beside the pages, unchanged. */
export interface TemplateAssets {
  /** The directory, relative to the project root. Every file under it is copied under the
   *  generator's `subDir`, at its path relative to this directory. */
  from: string;
}

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
   *  generator derives the data per unit and names each file via `outputPattern`.
   *  Mutually exclusive with `walk`. */
  scope?: TemplateScope;
  /** Output path pattern for the built-in `scope` walk: `{name}` `{Name}` `{package}`
   *  (SP-1 §3.3), and `{path}` (the node's or requirement's page in the docs view) for
   *  `perNode` and `perRequirement`. Required with `scope`; ignored with `walk`. */
  outputPattern?: string;
  /** What the template reads (see {@link TemplateData}). Default `entities`, except for
   *  `perNode` and `perRequirement`, which read only `docsView`. */
  data?: TemplateData;
  /** `perNode` and `perRequirement` only: which kinds get a page. A pattern is
   *  `<type>.<subType>`, `<type>.*` or `*`; a list matches any of its patterns. Default `*`.
   *  In `perNode`, `*` does not select requirement nodes, because `perRequirement` owns their
   *  pages; a pattern naming the requirement type (`requirement.*`) still selects them. */
  match?: string | readonly string[];
  /** A directory under the target the output paths are relative to, and the site root a
   *  docs-view page's `root` leads back to. Default: the target's own directory. */
  subDir?: string;
  /** A directory of static files (stylesheets, scripts) copied under `subDir` with the pages.
   *  Text files only: a file that is not UTF-8 is refused. */
  assets?: TemplateAssets;
  /** Check every relative link in this generator's pages once the whole run has rendered:
   *  each must name a file the run emitted (or one already on disk that a full run does not
   *  delete as no longer generated) and, with `#anchor`, an element carrying `id="anchor"` in it. A link that does not land fails the run, naming the
   *  page and the link. Requires `format: "html"`. */
  linkCheck?: boolean;
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

/** The scopes that walk the docs view, and so read only it. */
const VIEW_ONLY_SCOPES: readonly TemplateScope[] = ["perNode", "perRequirement"];
const MATCH_PATTERN = /^(\*|[A-Za-z][A-Za-z0-9_-]*\.(\*|[A-Za-z][A-Za-z0-9_-]*))$/;

/** Whether a node of `type`/`subType` is one `match` names. */
function matchesKind(patterns: readonly string[], type: string, subType: string): boolean {
  return patterns.some((p) => p === "*" || p === `${type}.*` || p === `${type}.${subType}`);
}

/** `../` once per directory in `path`: the way from a page back to its site root. */
function rootOf(path: string): string {
  return "../".repeat(path.split("/").length - 1);
}

/** Derive a `walk` over the neutral per-entity dictionary from a built-in scope + pattern. */
function entityScopeWalk(
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

/** The pages of a scope over the docs view. Every page's data is the whole view, plus `root`
 *  (the way back to the site root, so a link is `{{root}}{{path}}`) and, for one unit, the
 *  unit itself: `node`, `requirement` or `package`. */
function viewScopeWalk(view: DocsView, scope: TemplateScope, pattern: string, match: readonly string[]): TemplateWalkResult[] {
  const page = (outputPath: string, unit: Record<string, unknown>): TemplateWalkResult => ({
    data: { ...view, ...unit, root: rootOf(outputPath) },
    outputPath,
  });
  if (scope === "perNode") {
    const nonRequirement = match.filter((p) => p !== "*");
    return view.nodes
      .filter((n) => matchesKind(n.type === REQUIREMENT ? nonRequirement : match, n.type, n.subType))
      .map((n) => page(expandOutputPattern(pattern, { name: n.name, package: n.package, path: n.path }), { node: n }));
  }
  if (scope === "perRequirement") {
    return view.requirements
      .filter((r) => matchesKind(match, REQUIREMENT, r.subType))
      .map((r) => page(expandOutputPattern(pattern, { name: r.name, package: r.package, path: r.path }), { requirement: r }));
  }
  if (scope === "perPackage") {
    return view.packages.map((p) => page(expandOutputPattern(pattern, { package: p.name }), { package: p }));
  }
  if (scope === "perModel") return [page(expandOutputPattern(pattern, {}), {})];
  throw new Error(`the ${scope} scope does not read the docs view; use perNode with match "object.entity"`);
}

/** Every file under `dir`, relative to it with `/` separators, sorted by code unit. */
function filesUnder(dir: string): string[] {
  const out: string[] = [];
  const visit = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) visit(p);
      else out.push(relative(dir, p).split(sep).join("/"));
    }
  };
  visit(dir);
  return out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** The asset files, as output paths under `prefix`. */
function assetFiles(name: string, assets: TemplateAssets, project: string, prefix: string): EmittedFile[] {
  const from = resolve(project, assets.from);
  let isDir = false;
  try {
    isDir = statSync(from).isDirectory();
  } catch {
    // Reported below.
  }
  if (!isDir) throw new Error(`templateGenerator(${name}): the assets directory does not exist: ${assets.from}`);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return filesUnder(from).map((rel) => {
    let content: string;
    try {
      content = decoder.decode(readFileSync(join(from, rel)));
    } catch {
      throw new Error(`templateGenerator(${name}): asset ${assets.from}/${rel} is not a UTF-8 text file; assets are copied as text`);
    }
    return { path: prefix + rel, content };
  });
}

export const templateGenerator = function templateGenerator(
  opts: TemplateGeneratorOpts,
): Generator {
  const fmt: TemplateFormat = opts.format ?? "text";
  const hasWalk = typeof opts.walk === "function";
  const hasScope = opts.scope !== undefined;
  const label = `templateGenerator(${opts.name})`;
  if (hasWalk === hasScope) {
    throw new Error(`${label}: provide exactly one of \`walk\` or (\`scope\` + \`outputPattern\`)`);
  }
  if (hasScope && (opts.outputPattern === undefined || opts.outputPattern === "")) {
    throw new Error(`${label}: \`scope\` requires a non-empty \`outputPattern\``);
  }
  const viewOnly = hasScope && VIEW_ONLY_SCOPES.includes(opts.scope!);
  const data: TemplateData = opts.data ?? (viewOnly ? "docsView" : "entities");
  if (hasWalk && opts.data !== undefined) throw new Error(`${label}: \`data\` applies to a \`scope\`, not a \`walk\``);
  if (viewOnly && data !== "docsView") {
    throw new Error(`${label}: the ${opts.scope} scope reads the docs view; \`data\` must be "docsView"`);
  }
  if (data === "docsView" && opts.scope === "perEntity") {
    throw new Error(`${label}: the perEntity scope reads the entity dictionary; for a page per object over the docs view use perNode with match "object.*"`);
  }
  const match = opts.match === undefined ? ["*"] : typeof opts.match === "string" ? [opts.match] : [...opts.match];
  if (opts.match !== undefined) {
    if (!viewOnly) throw new Error(`${label}: \`match\` applies to the perNode and perRequirement scopes`);
    const bad = match.find((m) => !MATCH_PATTERN.test(m));
    if (match.length === 0 || bad !== undefined) {
      throw new Error(`${label}: \`match\` takes "<type>.<subType>", "<type>.*" or "*", got '${bad ?? "[]"}'`);
    }
  }
  if (opts.linkCheck === true && fmt !== "html") {
    throw new Error(`${label}: \`linkCheck\` reads HTML links, so it needs format "html"`);
  }
  const subDir = (opts.subDir ?? "").replace(/^\/+|\/+$/g, "");
  const prefix = subDir === "" ? "" : `${subDir}/`;
  // The pages the last generate() rendered, for the link check (the assets follow them).
  let pageCount = 0;
  let pagePaths: string[] = [];
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
      const walkRes = hasWalk
        ? await opts.walk!(ctx.loadedRoot)
        : data === "docsView"
          ? viewScopeWalk(runDocsView(ctx, label), opts.scope!, opts.outputPattern!, match)
          : entityScopeWalk(opts.scope!, opts.outputPattern!)(ctx.loadedRoot);
      const files: EmittedFile[] = [];
      for (const { data: payload, outputPath } of walkRes) {
        let content: string;
        try {
          content = render({
            ref: opts.template,
            payload,
            provider,
            format: fmt,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(
            `${label} failed rendering '${opts.template}' for '${outputPath}': ${msg}`,
            { cause: err instanceof Error ? err : undefined },
          );
        }
        files.push({ path: prefix + outputPath, content });
      }
      pageCount = files.length;
      pagePaths = files.map((f) => f.path);
      if (opts.assets !== undefined) {
        files.push(...assetFiles(opts.name, opts.assets, ctx.inputRoot ?? ctx.projectRoot ?? process.cwd(), prefix));
      }
      return files;
    },
  };
  if (opts.filter) generator.filter = opts.filter;
  if (opts.target) generator.target = opts.target;
  // The view lists the files each node produced, so it is built once the rest of the run has.
  if (data === "docsView") generator.readsRunOutput = true;
  // ADR-0064: the assets are read beside the model, so editing one regenerates.
  if (opts.assets !== undefined) generator.inputs = [opts.assets.from];
  if (opts.linkCheck === true) {
    generator.checkRunOutput = (run: RunOutputCheck): readonly string[] => {
      // The pages are the rendered files (the assets come after them), in the target's own
      // directory: the check works in paths relative to it, so its report reads as the output.
      const pages = run.own.slice(0, pageCount);
      const first = pages[0];
      if (first === undefined) return [];
      const outDir = first.fullPath.slice(0, first.fullPath.length - pagePaths[0]!.length);
      const dangling = findDanglingLinks(pagePaths.slice(0, pages.length), (p) => run.read(join(outDir, ...p.split("/"))));
      if (dangling.length === 0) return [];
      return [`link check failed, ${dangling.length} link(s) land on nothing: ${dangling.join("; ")}`];
    };
  }
  return generator;
} as GeneratorFactory<TemplateGeneratorOpts>;
