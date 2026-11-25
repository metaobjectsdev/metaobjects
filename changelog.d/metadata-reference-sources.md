- **Reference sources: name a prompt's reply type that another run generates.** A `sources`
  entry may carry `"reference": true` (Maven: `<loader><referenceSources>`). Its files load into
  the same tree, so a prompt's `@responseRef` (and any other reference) resolves against them,
  and no generator emits a type for a node declared only there. The prompt keeps its parser,
  output-format fragment and extractor, naming the reply type the other run generates. Before
  this, a reply type owned by another generator run could not be named at all (the load
  refused the unresolved `@responseRef`), and merging its files into the prompt's tree generated
  every reply type a second time. A `template.*` declared only in a reference source is refused
  (`ERR_REFERENCE_SOURCE_TEMPLATE`). Every port, pinned by `fixtures/reference-source-conformance/`.
