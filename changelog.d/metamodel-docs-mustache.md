- **metamodel-docs: the vocabulary reference pages are shared Mustache templates, and every
  port writes them.** `INDEX.md`, `providers.md` and the `types/<family>.md` pages are now the
  `templates/metamodel/` template set rendered over page data each port builds from its own
  registry vocabulary manifest and its embedded provider definitions. C#, Java, Kotlin, Python
  and Rust gain a `metamodel-docs` generator; every port is held to `fixtures/metamodel-docs/`
  (the page data under `data/` and the bytes under `expected/`). A project can override a
  page by placing a `templates/metamodel/<page>.mustache` of its own. The TypeScript pages are
  unchanged except one fix: `index.lookup` was missing its owning provider
  (`metaobjects-core-types`) and the provider of its `@fields`, because the index definition
  was left out of the provenance list.

  Upgrading: `@metaobjectsdev/metadata` no longer exports `renderMetamodelDocs`,
  `renderCoreMetamodelDocs`, `buildMetamodelProvenance` or the `MetamodelProvenance` type; it
  exports `coreMetamodelDocsPages()` and `buildMetamodelDocsPages()` (each page's path,
  template ref and data) instead, and codegen-ts renders them. An ejected
  `codegen/generators/metamodel-docs.ts` that calls `renderCoreMetamodelDocs` stops compiling:
  eject it again (`meta eject metamodel-docs`).
