### Rust: generate with `cargo meta gen`

1. **Config.** `metaobjects.config.json` at the project root (written by `cargo meta init`) is the
   generator list. Nothing is generated until it is listed:

   ```json
   { "generators": ["entity", "client", "commands"] }
   ```

   `entity` writes the model crate, `client` a typed client for the REST API the model implies,
   and `commands` command-line commands over that client (`client` needs `entity`; `commands`
   needs both). There is no server-side route or ORM generator for Rust yet. `cargo meta gen
   --list` is the catalog.
2. **Generate.** `cargo meta gen`. `cargo meta eject <name>` copies a generator into the repo
   to change what it emits.
