- **`meta gen` and `cargo meta gen`: the skip key now covers a linked generator package.** In
  TypeScript, the ADR-0064 skip key ignored every `@metaobjectsdev/*` package the config imported,
  on the assumption that the CLI aliases it onto its own engine copy. Only the packages the CLI
  actually aliases are left out now. Any other `@metaobjectsdev/*` package, such as an independent
  pack, is hashed like any third-party generator package: a linked or source checkout by the content
  of its files, an installed one by its version. In Rust, a crate the owned `codegen/` crate depends
  on by `path` is now an input too, followed through that crate's own path dependencies; the
  `metaobjects` and `metaobjects-codegen` engine crates are still covered by the engine's own source
  hash. Before this change, editing such a package's generator code while the model, the config and
  the lockfile stayed the same left the key unchanged, and `gen` skipped over stale output.
