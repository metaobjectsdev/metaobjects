// docsSiteFile() — the `docs-site` generator: the browsable HTML site of the project's model
// (`@metaobjectsdev/docs-site`), with navigation, search, a page per package and per object,
// and kind-aware ER diagrams. It was `meta docs --site` until 1.1.0 (ADR-0034 Amendment 9).
//
// The site BUILDER stays in its package: it assembles the page data the site's templates
// read, and what an adopter changes is those templates and the assets beside them. `meta eject
// docs-site` copies both into `codegen/docs-site/`, and this generator reads them from there
// when they exist (Amendment 8, ruling 3, as Amendment 9 restates it).
//
// The site loads the model with its own loader, from whole source DIRECTORIES (one page group
// each), so it reads the collection's source roots off the context rather than the loaded
// root every other generator walks.

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { generateSite } from "@metaobjectsdev/docs-site";
import type { EmittedFile, Generator, GeneratorFactory } from "../generator.js";
import { DOCS_TARGET_NAME } from "../docs-run.js";

/** The site lands here, under the target. */
const DEFAULT_SITE_DIR = "site";
/** Where `meta eject docs-site` writes the site's templates and assets, under the project. */
export const OWNED_DOCS_SITE_DIR = "codegen/docs-site";

export interface DocsSiteFileOpts {
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
  /** Where the pages load their third-party CSS and JS from (daisyUI, Tailwind's browser build,
   *  Mermaid, svg-pan-zoom). Default `https://cdn.jsdelivr.net/npm`, which needs network access
   *  to render; set it to your own mirror, or to a path you serve the five files from. Give an
   *  absolute URL or a root-relative path. See `@metaobjectsdev/docs-site` for the files. */
  assetBase?: string;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
}

export const docsSiteFile = function docsSiteFile(opts?: DocsSiteFileOpts): Generator {
  const dir = (opts?.subDir ?? DEFAULT_SITE_DIR).replace(/\/$/, "");
  const prefix = dir === "" ? "" : `${dir}/`;
  return {
    name: "docs-site",
    target: opts?.target ?? DOCS_TARGET_NAME,
    async generate(ctx) {
      const project = ctx.inputRoot ?? ctx.projectRoot ?? process.cwd();
      if (ctx.sourceRoots === undefined || ctx.sourceRoots.length === 0) {
        throw new Error(
          "docs-site: the run named no metadata source directories (ctx.sourceRoots), which the " +
            "site loads its model from. `meta gen` supplies them; a programmatic runGen() passes " +
            "`sourceRoots`.",
        );
      }
      // Prompt `.mustache` sources are searched beside the model: the project's `templates/`
      // and the `prompts` directory when given. Deduplicated by path: one directory named twice
      // would be loaded twice.
      const sourceDirs = [...ctx.sourceRoots];
      const seen = new Set(sourceDirs.map((d) => resolve(d)));
      const prompts = opts?.prompts === undefined ? undefined : resolve(project, opts.prompts);
      if (prompts !== undefined && !existsSync(prompts)) {
        ctx.warn(`docs-site: the prompts directory does not exist: ${prompts}`);
      }
      for (const d of [join(project, "templates"), ...(prompts !== undefined ? [prompts] : [])]) {
        const abs = resolve(d);
        if (existsSync(abs) && !seen.has(abs)) {
          sourceDirs.push(abs);
          seen.add(abs);
        }
      }
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
