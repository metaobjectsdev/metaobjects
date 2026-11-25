- **Python: the `requirements` and `agent-docs` generators.** `metaobjects gen` can now write
  `requirements.md`, `requirements.toon`, `agent/requirements.md` and the model-only
  `agent/schema.md` (`agent/ui.md` stays TypeScript-only). They render the shared Mustache
  templates from the pinned data model, held to `fixtures/docs-page-conformance/`; the templates
  are bundled in the package (`scripts/sync-doc-templates.sh` copies them, the doc-template drift
  gate checks the copy) and a same-named template under the project's templates directory
  overrides a page. Both are ejectable. The Python Mustache engine now treats a string-valued
  section as the context (`{{#statement}}{{{.}}}{{/statement}}`), as the spec and the TypeScript
  engine do.
