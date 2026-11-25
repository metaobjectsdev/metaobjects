- **Rust: `cargo meta verify --templates`, the template drift gate.** It checks every `template.*`
  body (and its partials) against the payload value object it renders over
  (`ERR_VAR_NOT_ON_PAYLOAD`, `ERR_PARTIAL_UNRESOLVED`, `ERR_OUTPUT_TAG_MISSING`,
  `ERR_REQUIRED_SLOT_UNUSED`, `ERR_TEMPLATE_SYNTAX`) and each prompt's reply, reading
  `@payloadRef`, `@textRef`, `@requiredTags` and `@responseRef` through `extends`. Bodies live
  under `prompts/` (`--prompts <dir>` to move it), and a bare `verify` runs the gate beside the
  codegen and rules gates. The `metaobjects-render` crate gains `verify`, held to
  `fixtures/verify-conformance/` (all 45 cases). A Jinja body is refused
  (`ERR_TEMPLATE_ENGINE_UNSUPPORTED`): the Rust renderer runs Mustache only. The old refusal
  of `--templates` is gone.
