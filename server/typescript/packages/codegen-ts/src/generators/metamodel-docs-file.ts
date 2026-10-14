// metamodelDocsFile() — the `metamodel-docs` generator: the reference of the built-in
// vocabulary (every type, subtype and attribute this build registers, and the provider that
// registers each), as `INDEX.md`, `providers.md` and one `types/<family>.md` per family.
//
// It documents the metamodel, not the project's model, so it reads no object: the strict
// registry of the core providers is its whole input. It was `meta docs --metamodel` until
// 1.1.0 (ADR-0034 Amendment 9).

import { composeRegistry, coreProviders, renderCoreMetamodelDocs } from "@metaobjectsdev/metadata";
import type { EmittedFile, Generator, GeneratorFactory } from "../generator.js";
import { DOCS_TARGET_NAME } from "../docs-run.js";

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
      for (const [path, content] of renderCoreMetamodelDocs(composeRegistry(coreProviders))) {
        files.push({ path: `${prefix}${path}`, content });
      }
      return files;
    },
  };
} as GeneratorFactory<MetamodelDocsFileOpts>;
