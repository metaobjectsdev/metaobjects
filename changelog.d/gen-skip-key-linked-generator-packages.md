- **`meta gen` and `cargo meta gen`: the skip key now covers a linked generator package.** In
  TypeScript, the ADR-0064 skip key ignored every `@metaobjectsdev/*` package the config imported,
  on the assumption that the CLI aliases it onto its own engine copy. Only the packages the CLI
  actually aliases are left out now. Any other `@metaobjectsdev/*` package, such as an independent
  pack, is hashed like any third-party generator package: a linked or source checkout by the content
  of its files, an installed one by its version. In Rust, a crate the owned `codegen/` crate depends
  on by `path`, in a build table or a `[patch]`, is now an input too, followed through that crate's
  own path dependencies and the workspace it inherits from; the `metaobjects` and
  `metaobjects-codegen` engine crates are still covered by the engine's own source hash. Both ports
  bump their fingerprint format, so the first `gen` after upgrading renders once. Before this change, editing such a package's generator code while the model, the config and
  the lockfile stayed the same left the key unchanged, and `gen` skipped over stale output.
