# metaobjects-cli

`cargo meta`: MetaObjects for Rust. Install it and run it inside a project:

```bash
cargo install metaobjects-cli
cargo meta init      # scaffold a project and its generator list
cargo meta gen       # generate the crates from the model
cargo meta verify    # fail when the generated crates drift from the model
cargo meta eject     # copy a generator into the project to own it
```

The package is `metaobjects-cli` because the crates.io name `cargo-meta` belongs to another
crate; the binary it installs is `cargo-meta`, so the command is still `cargo meta`.

`metaobjects.config.json` lists the generators a project runs. Schema migrations are the Node
`meta` command's, for every server language.

- Documentation: <https://metaobjects.dev>
- Source and the Rust port's page: <https://github.com/metaobjectsdev/metaobjects> (`docs/ports/rust.md`)
- License: Apache-2.0
