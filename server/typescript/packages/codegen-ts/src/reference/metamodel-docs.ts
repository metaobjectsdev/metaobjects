// REFERENCE TEMPLATE — copy this into your repo (e.g. codegen/generators/metamodel-docs.ts) and own it.
// Then import it LOCALLY in metaobjects.config.ts:
//   import { metamodelDocsFile } from "./codegen/generators/metamodel-docs.js";
//
// RUNTIME: this file executes under whatever runs `meta gen`, and the published CLI's
// shebang is `#!/usr/bin/env node` — so it runs under NODE even in a Bun project. Do not
// reach for `Bun.*` globals here; they are undefined and take the whole run down with
// `Bun is not defined`. Use `node:` builtins instead.
// targets:       Markdown. The pages document the metamodel itself, not your model.
// use-when:      you want to change the reference of the built-in vocabulary: which pages
//                are written or where they land. The packaged `metamodelDocsFile()` writes
//                them without this file; eject it only to change them.
// emits:         into the `docs` target, under `metamodel/` (or `subDir`): INDEX.md,
//                providers.md and one `types/<family>.md` per type family.
// customize:     the output directory and which pages are kept (`generate`). Each page's
//                data comes from `coreMetamodelDocsPages` in `@metaobjectsdev/metadata`, the
//                metamodel package, which is core and not handed over; the page layout is a
//                shared Mustache template (`metamodel/index.md`, `metamodel/providers.md`,
//                `metamodel/type-page.md`), and a same-named file under your `templates/`
//                directory wins over the shipped one.
// composes-with: nothing: it reads the registry, not the model.
//
// HOW IT RUNS. Like every generator: list it in `generators` in metaobjects.config.ts, with
// a `docs` target declared, and `meta gen` writes the pages (`meta verify --codegen` checks
// them).

import { coreMetamodelDocsPages } from "@metaobjectsdev/metadata";
import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  DOCS_TARGET_NAME,
  docsTemplateRoot,
  projectProvider,
} from "@metaobjectsdev/codegen-ts/engine";
import { renderDocPage } from "../render-engine/doc-page.js";

/** The pages land here, under the target. */
const DEFAULT_METAMODEL_DIR = "metamodel";

export interface MetamodelDocsFileOpts {
  /** Output prefix under the target. Default `metamodel`; `""` writes at the target root. */
  subDir?: string;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
  /**
   * The directory whose `templates/` overrides a page: a `templates/metamodel/<page>.mustache`
   * there wins over the shipped one. Resolved against the project root; default the project root.
   */
  templates?: string;
}

export const metamodelDocsFile = function metamodelDocsFile(opts?: MetamodelDocsFileOpts): Generator {
  const dir = (opts?.subDir ?? DEFAULT_METAMODEL_DIR).replace(/\/$/, "");
  const prefix = dir === "" ? "" : `${dir}/`;
  return {
    name: "metamodel-docs",
    target: opts?.target ?? DOCS_TARGET_NAME,
    generate(ctx) {
      const provider = projectProvider(docsTemplateRoot(ctx, opts?.templates));
      const files: EmittedFile[] = [];
      // OWNED: which pages are written, and where. The vocabulary of the core providers is
      // the whole input.
      for (const page of coreMetamodelDocsPages()) {
        const path = `${prefix}${page.path}`;
        files.push({ path, content: renderDocPage(page.template, page.data, provider, path) });
      }
      return files;
    },
  };
} as GeneratorFactory<MetamodelDocsFileOpts>;
