# Working with MetaObjects in this project

> Stack: typescript server, react, tanstack client; migrations are TS.

MetaObjects is a metadata standard: typed metadata in `metaobjects/` is the durable
spine; generated code is the disposable artifact. Regenerate with `npx meta gen`.

## Principles
- Pattern-derivable from metadata = codegen, never hand-write (FKs, CRUD, validators, finders).
- Never hand-edit generated files — change the metadata and regenerate (three-way merge preserves hand-written regions).
- Use the generated constants for any string that names metadata.

## Authoring rules you must not violate
- Nodes are fused-key maps: `{"<type>.<subType>": { ... }}` (e.g. `{"field.string": {"name": "email"}}`) — never split the type and subtype into separate keys.
- Attribute names are unique within a node; for multi-value use one array attr (`@values: [...]`).
- An inline `@maxLength: 50` equals an `attr` child of the same name — never write both.
- Package paths use `::` (`acme::common::id`).

## Going deeper (Claude Code)
For authoring, codegen, runtime/UI, prompts, or verify work, use the matching
`metaobjects-*` skill — its body links the `references/<lang>.md` fragment installed
for this project's stack.
