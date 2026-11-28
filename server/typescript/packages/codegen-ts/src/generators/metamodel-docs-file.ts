// metamodelDocsFile() — the `metamodel-docs` generator: the reference of the built-in
// vocabulary (every type, subtype and attribute this build registers, and the provider that
// registers each), as `INDEX.md`, `providers.md` and one `types/<family>.md` per family.
//
// It documents the metamodel, not the project's model, so it reads no object: the registry
// vocabulary manifest and the provider definitions of the core providers are its whole input
// (`coreMetamodelDocsPages`). Each page is a shared Mustache template (`templates/metamodel/`)
// fed that data, the same template set every port renders. It was `meta docs --metamodel`
// until 1.1.0 (ADR-0034 Amendment 9).

import { coreMetamodelDocsPages } from "@metaobjectsdev/metadata";
import type { EmittedFile, Generator, GeneratorFactory } from "../generator.js";
import { DOCS_TARGET_NAME } from "../docs-run.js";
import { docsTemplateRoot, projectProvider } from "../render-engine/framework-provider.js";
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
      for (const page of coreMetamodelDocsPages()) {
        const path = `${prefix}${page.path}`;
        files.push({ path, content: renderDocPage(page.template, page.data, provider, path) });
      }
      return files;
    },
  };
} as GeneratorFactory<MetamodelDocsFileOpts>;
