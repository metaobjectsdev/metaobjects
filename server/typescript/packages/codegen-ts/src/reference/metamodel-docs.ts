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
// customize:     the output directory and which pages are kept (`generate`). The pages are
//                rendered by `renderCoreMetamodelDocs` from `@metaobjectsdev/metadata`, the
//                metamodel package, which is core and not handed over.
// composes-with: nothing: it reads the registry, not the model.
//
// HOW IT RUNS. Like every generator: list it in `generators` in metaobjects.config.ts, with
// a `docs` target declared, and `meta gen` writes the pages (`meta verify --codegen` checks
// them).

import { composeRegistry, coreProviders, renderCoreMetamodelDocs } from "@metaobjectsdev/metadata";
import {
  type EmittedFile,
  type Generator,
  type GeneratorFactory,
  DOCS_TARGET_NAME,
} from "@metaobjectsdev/codegen-ts/engine";

/** The pages land here, under the target. */
const DEFAULT_METAMODEL_DIR = "metamodel";

export interface MetamodelDocsFileOpts {
  /** Output prefix under the target. Default `metamodel`; `""` writes at the target root. */
  subDir?: string;
  /** Named output target. Default `"docs"`, which `targets` must declare. */
  target?: string;
}

export const metamodelDocsFile = function metamodelDocsFile(opts?: MetamodelDocsFileOpts): Generator {
  const dir = (opts?.subDir ?? DEFAULT_METAMODEL_DIR).replace(/\/$/, "");
  const prefix = dir === "" ? "" : `${dir}/`;
  return {
    name: "metamodel-docs",
    target: opts?.target ?? DOCS_TARGET_NAME,
    generate() {
      const files: EmittedFile[] = [];
      // OWNED: which pages are written, and where. The registry of the core providers is the
      // whole input.
      for (const [path, content] of renderCoreMetamodelDocs(composeRegistry(coreProviders))) {
        files.push({ path: `${prefix}${path}`, content });
      }
      return files;
    },
  };
} as GeneratorFactory<MetamodelDocsFileOpts>;
