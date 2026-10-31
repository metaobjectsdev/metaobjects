# `contract-conformance/` — the contract emitters' corpus (FR-022)

Golden output for `jsonSchemaFile()` (stable name `contract-schema`) and `openApiFile()` (stable
name `openapi`). Both are neutral artifacts with one engine in TypeScript (ADR-0022), so this corpus
has one runner and gates bytes, not behaviour between ports:
`server/typescript/packages/codegen-ts/test/contract/contract-corpus.test.ts`.

Each case is a directory.

- `meta.json`, or `case.json` naming a shared metadata file. Most cases reuse an api-contract
  corpus model, because that is the surface every port's routes are held to.
- `case.json` keys: `meta` (repository-relative), `wire` (the setting, as in
  `.metaobjects/config.json`), `strictExclude` (objects the strict profile leaves out, because the
  strict subset cannot state them) and `reportExport` (the project wires `report-export`).
- `expected/`: the exact tree the emitters write: the canonical schemas, the strict schemas and
  `openapi.json`. Or `expected-error.txt`: the exact refusal.

Regenerate with `bun run gen:contract-conformance` from `server/typescript/packages/codegen-ts`. An
`expected-error.txt` is written by hand.

The corpus test also passes every document through tools that know nothing about MetaObjects: Ajv
in strict mode for JSON Schema 2020-12, a validator of the OpenAPI 3.1 specification's schema, and
the strict subset's rules. The integration suite then holds the OpenAPI goldens to real answers: it
checks every request of the api-contract corpus, on the generated TypeScript routes, against the
document for that corpus.

| Case | Holds |
|---|---|
| `all-fields` | Every wire type, every constraint, a value object, a map, a recursive value object, a credential, and the write-mode fields. |
| `all-fields-wire-string-emit` | `all-fields` under `wire: { decimals: "string", nullMembers: "emit" }`. |
| `all-fields-wire-string-omit` | `all-fields` under `wire: { decimals: "string", nullMembers: "omit" }`. |
| `blog` | The api-contract corpus's root model: CRUD, filter, sort and paging. |
| `decimal` | The api-contract `decimal/` model. |
| `error-name-collision` | Refused: a real object takes the name of another object's create shape. |
| `error-name-collision-list` | Refused: a real object takes the name of another object's list response. |
| `error-strict-map` | Refused: the strict subset has no map. |
| `error-strict-recursive` | Refused: the strict subset has no recursion. |
| `jsonb` | The api-contract `jsonb/` model: value objects, arrays of them and maps. |
| `m2m` | The api-contract `m2m/` model: traversal routes, also over TPH. |
| `projection` | The api-contract `projection/` model: read-only surfaces, keyed and keyless. |
| `report` | The api-contract `report/` model: served reports, and the rest of the model around them. |
| `secret-fields` | The api-contract `secret-fields/` model: a credential is not on the wire. |
| `tph` | The api-contract `tph/` model: a polymorphic base and per-subtype routes. |
| `write-through` | The api-contract `write-through/` model. |
