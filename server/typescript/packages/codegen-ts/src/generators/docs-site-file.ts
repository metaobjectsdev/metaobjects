// docsSiteFile() — the `docs-site` generator: the browsable HTML site of the project's model
// (`@metaobjectsdev/docs-site`), with navigation, search, a page per package and per object,
// and kind-aware ER diagrams. It was `meta docs --site` until 1.1.0 (ADR-0034 Amendment 9).
//
// The site BUILDER stays in its package: it assembles the page data the site's templates
// read, and what an adopter changes is those templates and the assets beside them. `meta eject
// docs-site` copies both into `codegen/docs-site/`, and this generator reads them from there
// when they exist (Amendment 8, ruling 3, as Amendment 9 restates it).
//
// Two sites, chosen by `site`:
//
//   explorer  (the default) the model explorer: what the software does (the requirement
//             tree), the model map, a page per object, prompt, requirement and route, the
//             coverage matrix, the trace and the gaps. Every page reads one document,
//             `explorer.json`, which this generator builds from the effective model, the
//             requirement ledger the caller computed (`ctx.requirementLedger`), the files this
//             run wrote (`ctx.runOutput`) and the routes the run mounts. It runs after every
//             other generator, so the files it lists are this run's.
//   classic   the site before the explorer: a page per package and per object with ER
//             diagrams. It loads the model with its own loader, from whole source DIRECTORIES
//             (one page group each), so it reads the collection's source roots off the context.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { canonicalSerializeEffective } from "@metaobjectsdev/metadata";
import {
  buildExplorer,
  generateExplorerSite,
  generateSite,
  readPromptTexts,
  type ExplorerRoute,
} from "@metaobjectsdev/docs-site";
import type { EmittedFile, GenContext, Generator, GeneratorFactory } from "../generator.js";
import { DOCS_TARGET_NAME } from "../docs-run.js";
import { buildApiModelForRun } from "./api-model.js";

/** The site lands here, under the target. */
const DEFAULT_SITE_DIR = "site";
/** Where `meta eject docs-site` writes the site's templates and assets, under the project. */
export const OWNED_DOCS_SITE_DIR = "codegen/docs-site";

/** The two sites `docsSiteFile()` builds. */
export const DOCS_SITE_EXPLORER = "explorer";
export const DOCS_SITE_CLASSIC = "classic";
export type DocsSiteKind = typeof DOCS_SITE_EXPLORER | typeof DOCS_SITE_CLASSIC;

/** The file every explorer theme template set carries, so an owned set can be told apart from
 *  an owned classic one. */
const EXPLORER_MARKER_TEMPLATE = "explorer-head.mustache";

export interface DocsSiteFileOpts {
  /** Which site: `explorer` (default), the model explorer, or `classic`, the per-package site
   *  with ER diagrams that shipped before it. */
  site?: DocsSiteKind;
  /** A directory holding prompt `.mustache` sources outside `metaobjects/` and `templates/`,
   *  relative to the project, so the site can show prompt TEXT. */
  prompts?: string;
  /** Output prefix under the target. Default `site`. */
  subDir?: string;
  /** The site's title. Default: the project directory's name. */
  title?: string;
  /** Printed in every page's footer, e.g. a date or a version. Default: none, so the pages
   *  depend on the model alone and `meta verify --codegen` can hold them to it. A date here
   *  makes every day's run differ from the last. */
  stamp?: string;
  /** Where the pages load their third-party CSS and JS from: the explorer loads Cytoscape for
   *  its graphs, the classic site daisyUI, Tailwind's browser build, Mermaid and svg-pan-zoom.
   *  Default `https://cdn.jsdelivr.net/npm`, which needs network access to draw them; set it to
   *  your own mirror, or to a path you serve the files from. Give an absolute URL or a
   *  root-relative path. See `@metaobjectsdev/docs-site` for the files. */
  assetBase?: string;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
}

export const docsSiteFile = function docsSiteFile(opts?: DocsSiteFileOpts): Generator {
  const dir = (opts?.subDir ?? DEFAULT_SITE_DIR).replace(/\/$/, "");
  const prefix = dir === "" ? "" : `${dir}/`;
  const kind = opts?.site ?? DOCS_SITE_EXPLORER;
  return {
    name: "docs-site",
    target: opts?.target ?? DOCS_TARGET_NAME,
    // The explorer lists the files the run generated, so it runs after the rest.
    ...(kind === DOCS_SITE_EXPLORER && { readsRunOutput: true }),
    async generate(ctx) {
      const project = ctx.inputRoot ?? ctx.projectRoot ?? process.cwd();
      if (kind === DOCS_SITE_EXPLORER) return explorerSite(ctx, project, prefix, opts);
      if (ctx.sourceRoots === undefined || ctx.sourceRoots.length === 0) {
        throw new Error(
          "docs-site: the run named no metadata source directories (ctx.sourceRoots), which the " +
            "site loads its model from. `meta gen` supplies them; a programmatic runGen() passes " +
            "`sourceRoots`.",
        );
      }
      const sourceDirs = promptSourceDirs(ctx, project, opts, ctx.sourceRoots);
      const ownedTemplates = join(project, OWNED_DOCS_SITE_DIR, "templates");
      const ownedAssets = join(project, OWNED_DOCS_SITE_DIR, "assets");
      // The builder writes to a directory (its link check reads the pages back), so the site
      // is built in a scratch directory and returned as files for the runner to write.
      const scratch = mkdtempSync(join(tmpdir(), "meta-docs-site-"));
      try {
        const result = await generateSite({
          sourceDirs,
          outDir: scratch,
          title: opts?.title ?? (basename(project) || "Metadata"),
          stamp: opts?.stamp ?? "",
          commit: "",
          core: { n: 15 },
          ...(opts?.assetBase !== undefined ? { assetBase: opts.assetBase } : {}),
          ...(ctx.providers !== undefined ? { extraProviders: ctx.providers } : {}),
          ...(existsSync(ownedTemplates) ? { templatesDir: ownedTemplates } : {}),
          ...(existsSync(ownedAssets) ? { assetsDir: ownedAssets } : {}),
        });
        const written = [
          ...result.pages,
          "assets/site.css",
          "assets/site.js",
          "assets/search-index.json",
        ];
        const files: EmittedFile[] = written.map((path) => ({
          path: `${prefix}${path}`,
          content: readFileSync(join(scratch, path), "utf8"),
        }));
        return files;
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  };
} as GeneratorFactory<DocsSiteFileOpts>;

/** Prompt `.mustache` sources are searched beside the model: the source roots, the project's
 *  `templates/` and the `prompts` directory when given. Deduplicated by path: one directory
 *  named twice would be loaded twice. */
function promptSourceDirs(ctx: GenContext, project: string, opts: DocsSiteFileOpts | undefined, roots: readonly string[]): string[] {
  const dirs = [...roots];
  const seen = new Set(dirs.map((d) => resolve(d)));
  const prompts = opts?.prompts === undefined ? undefined : resolve(project, opts.prompts);
  if (prompts !== undefined && !existsSync(prompts)) {
    ctx.warn(`docs-site: the prompts directory does not exist: ${prompts}`);
  }
  for (const d of [join(project, "templates"), ...(prompts !== undefined ? [prompts] : [])]) {
    const abs = resolve(d);
    if (existsSync(abs) && !seen.has(abs)) {
      dirs.push(abs);
      seen.add(abs);
    }
  }
  return dirs;
}

/** The routes the run mounts, as the api reference states them (`METHOD /path` per symbol). */
function runRoutes(ctx: GenContext): ExplorerRoute[] {
  const routes: ExplorerRoute[] = [];
  for (const unit of buildApiModelForRun(ctx).units) {
    const node = unit.package !== undefined && unit.package !== "" ? `${unit.package}::${unit.node}` : unit.node;
    for (const sym of unit.symbols) {
      if (sym.kind !== "rest") continue;
      const space = sym.name.indexOf(" ");
      if (space < 0) continue;
      routes.push({ node, method: sym.name.slice(0, space), path: sym.name.slice(space + 1) });
    }
  }
  return routes;
}

async function explorerSite(ctx: GenContext, project: string, prefix: string, opts: DocsSiteFileOpts | undefined): Promise<EmittedFile[]> {
  // The manifest's shape (path → generatedBy, sourceNode), from the files this run wrote: a
  // fresh clone builds the same site as the machine that last generated.
  const manifest: Record<string, { generatedBy: string; sourceNode?: string }> = {};
  for (const f of ctx.runOutput?.() ?? []) {
    manifest[f.path] = { generatedBy: f.generatedBy, ...(f.sourceNode !== undefined && { sourceNode: f.sourceNode }) };
  }
  // The ledger is the requirement gate's; a gate that throws leaves the section out (as a
  // missing verify input does) rather than failing the whole run in the docs step.
  let ledger: unknown;
  try {
    ledger = ctx.requirementLedger?.();
  } catch (err) {
    ctx.warn(`docs-site: the requirement ledger could not be built, so the site shows none: ${err instanceof Error ? err.message : String(err)}`);
  }
  // No route at all means this run recorded none (no routes generator, or REST off), which the
  // site says as such; an empty list would claim the run mounted nothing.
  const routes = runRoutes(ctx);
  const explorer = buildExplorer({
    model: JSON.parse(canonicalSerializeEffective(ctx.loadedRoot)) as unknown,
    ...(ledger !== undefined && { verify: ledger }),
    manifest,
    ...(routes.length > 0 && { routes }),
  });
  const texts = readPromptTexts(explorer, promptSourceDirs(ctx, project, opts, ctx.sourceRoots ?? []));
  const ownedTemplates = join(project, OWNED_DOCS_SITE_DIR, "templates");
  const ownedAssets = join(project, OWNED_DOCS_SITE_DIR, "assets");
  if (existsSync(ownedTemplates) && !existsSync(join(ownedTemplates, EXPLORER_MARKER_TEMPLATE))) {
    ctx.warn(
      `docs-site: ${OWNED_DOCS_SITE_DIR}/templates holds the classic site's theme, which the explorer ` +
        "does not read; it uses its bundled templates. Re-run `meta eject docs-site` to own the " +
        "explorer's theme, or pass `site: \"classic\"`.",
    );
  }
  const scratch = mkdtempSync(join(tmpdir(), "meta-docs-site-"));
  try {
    const result = generateExplorerSite({
      explorer,
      outDir: scratch,
      title: opts?.title ?? (basename(project) || "Metadata"),
      stamp: opts?.stamp ?? "",
      texts,
      ...(opts?.assetBase !== undefined ? { assetBase: opts.assetBase } : {}),
      ...(existsSync(ownedTemplates) ? { templatesDir: ownedTemplates } : {}),
      ...(existsSync(ownedAssets) ? { assetsDir: ownedAssets } : {}),
    });
    return result.files.map((path) => ({
      path: `${prefix}${path}`,
      content: readFileSync(join(scratch, path), "utf8"),
    }));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
