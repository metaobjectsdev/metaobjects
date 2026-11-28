- **C# and Python: the model explorer with no Node.** Both ports build the docs view from their
  loaded model (`MetaObjects.DocsView` in C#, `metaobjects.docs_view` in Python), byte for byte
  what TypeScript builds for every `fixtures/explorer-conformance/` case. A new `docs-site`
  generator in each registry (`DocsSiteGenerator` in `codegen/Generators.cs`; `docs-site` in a
  Python target's `generators`) writes `explorer.json`, the explorer app, `explorer-model.js`
  and `explorer-stamp.js`. Each object lists the files generated for it: this run's (the runner
  runs the generator after every other one) and the committed manifest's outside the directories
  the run's orphan sweep clears, so `verify --codegen` renders what `gen` wrote. Options name a
  `verify --format json` payload and a routes file. The running application can serve the same
  view at `{apiPrefix}/_meta/docs`: `MetaEndpoint.MetaDocs(root)` (C#) and `meta_docs(root)`
  (Python) build it once and carry its ETag; the host mounts it as it mounts `/_meta`.
  C# and Python provenance now names a generator by its registry name (`entity`,
  `filter-allowlist`, `routes`), as TypeScript and the JVM do.
