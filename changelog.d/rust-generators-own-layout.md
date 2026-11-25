- **Rust generators own their layout, take options and expose their parts (ADR-0063).** A
  layout ratchet (`tests/layout_ratchet.rs`) parses every generator source with `syn` and fails
  on a hand-typed line break or indentation run; its allowlist can only shrink, and it starts
  empty but for six files whose strings are not generated code. Nine `rust` writer-conformance
  cases pin the dialect (`use_list`, `doc`, `prose`, `doc_break`, `assign`), each a rustfmt fixed
  point under the generated crates' `rustfmt.toml`. An entry in `metaobjects.config.json`'s
  `generators` may now be `{"name": ..., "options": {...}}`: `Generator::configure` receives the
  options, and the shipped generators take none and refuse any key with
  `ERR_UNKNOWN_GENERATOR_OPTION`, also on a run `--generators` narrows. Each shipped generator
  has a `*Parts` trait (`EntityParts`, `ClientParts`, `CommandsParts`, `RenderHelperParts`,
  `OutputParserParts`, `OutputPromptParts`) with one default method per output piece, so an owned
  generator overrides one piece and keeps the rest. Generated output is byte-identical but for
  one fix: `assign` now moves an array right-hand side to the next line when that is where
  rustfmt puts it under those settings.
