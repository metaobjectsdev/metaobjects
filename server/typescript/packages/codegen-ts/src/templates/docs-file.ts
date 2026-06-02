// Backward-compatible facade over the rc.12+ template-driven docsFile()
// implementation. The Markdown structure now lives in
// `templates/docs/entity-page.md.mustache`; this module preserves the
// `renderDocsFile()` + `DocsRenderOpts` exports so the per-section unit
// tests in `test/templates/docs-file.test.ts` keep working without
// modification.
//
// Adopters writing custom docs templates should import the public surface
// from `@metaobjectsdev/codegen-ts/generators` instead:
//   - `buildEntityDocData(entity, opts)` for the typed data dict
//   - `templateGenerator({ template: "docs/entity-page.md", ... })` for the
//     standard end-to-end generator

import type { MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import type { Dialect } from "../column-mapper.js";
import type { ColumnNamingStrategy } from "../metaobjects-config.js";
import { render } from "@metaobjectsdev/render";
import { buildEntityDocData } from "../generators/docs-data-builder.js";
import { frameworkTemplatesProvider } from "../render-engine/framework-provider.js";

export interface DocsRenderOpts {
  dialect: Dialect;
  columnNamingStrategy?: ColumnNamingStrategy;
  loadedRoot: MetaRoot;
}

/** Backward-compatible entry point: builds the EntityDocData payload and
 *  renders it via the framework template. Output is gated by
 *  `docs-file-conformance.test.ts`. */
export function renderDocsFile(entity: MetaObject, opts: DocsRenderOpts): string {
  const data = buildEntityDocData(entity, {
    dialect: opts.dialect,
    ...(opts.columnNamingStrategy !== undefined
      ? { columnNamingStrategy: opts.columnNamingStrategy }
      : {}),
    loadedRoot: opts.loadedRoot,
  });
  return render({
    ref: "docs/entity-page.md",
    payload: data,
    provider: frameworkTemplatesProvider,
    format: "markdown",
  });
}
