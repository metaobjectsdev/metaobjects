# template-generator conformance fixtures

Cross-port byte-equivalence corpus for the `templateGenerator()` factory
(see `spec/design-docs/2026-05-28-cross-port-template-generator.md`).

Each port's conformance harness reads every fixture directory under
`fixtures/render-conformance/template-generator/`, runs its
`templateGenerator()` with the fixture's metadata + template + walk,
and asserts each emitted file equals `expected/<outputPath>` byte-for-byte.

## Fixture format

Each fixture is a directory containing:

| File | Purpose |
|---|---|
| `meta.json` | Declarative metadata (entities + fields) the harness materializes into a MetaRoot. |
| `template.mustache` | The shared Mustache template. |
| `walk.json` | Declarative walk result: list of `{ entity?, data, outputPath }` tuples. |
| `expected/<outputPath>` | Byte-exact expected output, one file per walk entry. |

### `meta.json` schema

```json
{
  "format": "text",
  "entities": [
    { "name": "Post", "fields": [
        { "name": "id", "type": "long" },
        { "name": "title", "type": "string" }
    ]},
    { "name": "Comment", "fields": [
        { "name": "id", "type": "long" }
    ]}
  ]
}
```

`format` is one of the port's render formats (`text` / `html` / `markdown` / etc.) and drives escaping. `entities[].fields[].type` is one of the shared field shortnames (`string`, `long`, `boolean`, `int`, `double`, `date`) — each port's adapter maps these to its own `FIELD_SUBTYPE_*` constants.

### `walk.json` schema

```json
[
  { "entity": "Post",    "data": { "name": "Post" },    "outputPath": "Post.txt" },
  { "entity": "Comment", "data": { "name": "Comment" }, "outputPath": "Comment.txt" }
]
```

- `entity` (optional): name of the entity from `meta.json` this walk entry corresponds to. The per-port adapter MAY use this to look up the actual entity object and validate the data dict refers to a known entity. Omit for aggregator-pattern fixtures (one output file aggregating all entities).
- `data`: the dict passed to `render()` as the payload for this output.
- `outputPath`: relative path under the fixture's `expected/` directory.

### Adding a new fixture

1. Create the fixture directory under `fixtures/render-conformance/template-generator/`.
2. Write `meta.json`, `template.mustache`, `walk.json`.
3. Generate `expected/<outputPath>` by hand (or by running the TS harness with a deliberate placeholder + copying the output once you've eyeball-confirmed it).
4. Run every port's conformance harness — all should pass.

## Per-port adapters

Each port's conformance harness:

1. Parses `meta.json` → builds a MetaRoot via its own `_meta-build`-equivalent helpers.
2. Parses `walk.json` → builds a walk function returning those tuples (resolving `entity` references against the MetaRoot when present).
3. Reads `template.mustache` → registers it in an in-memory Provider.
4. Calls `templateGenerator(...)` → gets emitted files.
5. For each emitted file, asserts its content equals `expected/<outputPath>` byte-for-byte.

The adapter is the only per-port code in the conformance suite.
