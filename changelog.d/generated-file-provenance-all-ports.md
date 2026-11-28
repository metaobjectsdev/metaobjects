- **C#, Java and Python codegen record which node each generated file came from.** After a write
  run, the hash manifest entry of a per-object file names its generator and the node's resolution
  key, `{ "hash", "generatedBy", "sourceNode" }` (after the JVM's `generator` and `outputDir`),
  exactly as TypeScript already wrote it. A docs view built from any of these ports' manifests now
  lists each node's generated files, so the explorer's "generated files" panel is filled. A file
  rendered from the whole model or a package keeps the plain hash. The shared `provenance` vector in
  `fixtures/codegen-skip-conformance/manifests.json` holds all four ports to the same entries.

  Upgrading: the next `gen` rewrites the committed `.metaobjects/.gen-state/.hashes/` files once,
  adding the two fields to each per-object entry. Commit them; generated source files do not change.
