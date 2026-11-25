- **Rust port's prompt tier: `render-helper`, `output-parser` and `output-prompt`.** Three
  generators put the `metaobjects-render` crate (render, the strict JSON parse and the tolerant
  `extract`, the output-format fragment) behind typed functions, held to the render,
  template-output and extract corpora. They write a crate each beside the model crate:
  `<package>_prompts` (a typed render function per prompt), `<package>_parsers` (`parse_<prompt>`
  for a JSON reply, `extract_<prompt>` for any, and the extract schema) and `<package>_formats`
  (the fragment and its descriptor), for every prompt with a `@responseRef` (ADR-0052). `eject`
  copies all three, and `gen` checks each body against its payload before it writes a render function.
  The generated crates depend on `metaobjects-render` at this release's major and minor.
