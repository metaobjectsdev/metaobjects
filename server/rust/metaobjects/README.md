# metaobjects

The MetaObjects metamodel for Rust: the registry, the loader (JSON and YAML), the validation
passes, and the canonical serializer. It is the Rust port of the cross-language MetaObjects
standard, held to the same shared conformance corpora as the TypeScript, C#, Java, Kotlin and
Python ports.

Most projects do not depend on this crate directly: they install the `cargo meta` command
(`metaobjects-cli`) and run its generators. Depend on `metaobjects` to read a project's model
from your own tool.

- Documentation: <https://metaobjects.dev>
- Source and the Rust port's page: <https://github.com/metaobjectsdev/metaobjects> (`docs/ports/rust.md`)
- License: Apache-2.0
