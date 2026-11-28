- **Java and Kotlin: the model explorer with no Node.** The JVM builds the docs view from its
  loaded model (`com.metaobjects.docsview.DocsView`), byte for byte what TypeScript builds for
  every `fixtures/explorer-conformance/` case. A new `docs-site` generator
  (`com.metaobjects.generator.DocsSiteGenerator`, in both the Java and Kotlin registries) writes
  `explorer.json`, the explorer app, `explorer-model.js` and `explorer-stamp.js`; each object
  lists the files generated for it: this execution's (it builds the site after every other
  generator it runs) and the committed manifest's for the module's other executions, so
  `metaobjects:verify` renders what `generate` wrote. Optional args name a
  `verify --format json` payload (`verifyFile`) and the routes (`routesFile`). The running
  application can serve the same view at `{apiPrefix}/_meta/docs`: `MetaEndpoint.docs(root)`
  builds it once and carries its ETag, and the host mounts it as it mounts `/_meta`. The static
  export and the classic site stay TypeScript's.
