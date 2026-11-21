# metaobjects-codegen

The code-generation engine of the MetaObjects Rust port, and its generators: `entity` (serde
structs, enums, value objects and request bodies, with `validate()`), `client` (a typed HTTP
client for the REST API the model implies) and `commands` (command-line commands over that
client).

The engine decides whether anything changed, renders through the generators, writes only the
files whose bytes changed, and refuses to overwrite a generated file somebody edited. The
generated code imports ordinary crates.io crates and nothing from MetaObjects.

You normally run it through `cargo meta` (`metaobjects-cli`). A project that wants to own a
generator copies it with `cargo meta eject`, and that copy builds against this crate.

- Documentation: <https://metaobjects.dev>
- Source and the Rust port's page: <https://github.com/metaobjectsdev/metaobjects> (`docs/ports/rust.md`)
- License: Apache-2.0
