# metaobjects-render

Prompt rendering for the MetaObjects Rust port. A `template.*` body is plain Mustache; this crate
renders it over a payload deterministically, so the same template and payload give the same bytes
in every MetaObjects port:

- partials are expanded ahead of time, with a cycle guard and a depth limit;
- every `{{value}}` is escaped for the template's format (`text`, `markdown`, `html`, `xml`, `csv`,
  `spreadsheet`, `json`), and `{{{value}}}` / `{{&value}}` bypass it;
- a payload carries derived `has<Field>` booleans and a `-last` flag on each object element of a list;
- `maxChars` is a fail-closed budget: an over-budget render is an error, never a truncation.

The Mustache engine underneath is [`mustache-ng`](https://crates.io/crates/mustache-ng). The
behaviour is held to the shared `fixtures/render-conformance/` corpus that every port runs.

The other half of a prompt is the answer. `extract::extract` reads a typed answer out of a model's
reply, tolerating fences, prose, comments, trailing commas and cut-off values, and reports how each
declared field came out (`EXTRACTED`, `DEFAULTED`, `LOST_OPTIONAL`, `LOST_REQUIRED`, `MALFORMED`)
rather than failing. `prompt::render_output_format` writes the fragment that asks the model for that
answer. Both are held to `fixtures/extract-conformance/` and `fixtures/output-prompt-conformance/`.

- Documentation: <https://metaobjects.dev>
- Source and the Rust port's page: <https://github.com/metaobjectsdev/metaobjects> (`docs/ports/rust.md`)
- License: Apache-2.0
