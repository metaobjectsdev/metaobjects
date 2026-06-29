# `api-contract-conformance/jsonb/` — jsonb open-bag parsed-value corpus

Cross-port REST contract for the **`field.string @dbColumnType:jsonb` open
JSON bag** at the API boundary. The field is a bare jsonb column that may hold
*any* JSON value; the contract is that a client POSTs a JSON **object** to it
and reads back the same **object** — never a JSON-encoded **string**
(`"{\"k\":\"v\"}"`).

This closes a real gap: the persistence-conformance corpus
(`queries/asset-uuid-roundtrip.yaml`) gates the runtime/ORM **wire** form of a
jsonb column, but nothing gated that each port's **generated DTO/validator +
controller** accept a posted object and surface a parsed value over HTTP. Each
port already carries the fix on `main` (TS `z.unknown()`, Python `Any`,
Java `Object`, Kotlin `JsonElement`, C# `JsonDocument`); this corpus locks it
in cross-port.

The single `Document` entity (`acme::store`, `@table="documents"`) carries one
open-bag field:

| Field     | Type                              | Notes                       |
|-----------|-----------------------------------|-----------------------------|
| `id`      | `field.long`                      | `identity.primary @generation=increment` |
| `title`   | `field.string`                    | `@required` + `@maxLength 200` |
| `payload` | `field.string @dbColumnType=jsonb`| open JSON bag — parsed value over the wire |

`source.rdb @table="documents"` → the URL segment is `/api/documents`
(lowercased + pluralized), per the cross-port grammar.

## Files

```
jsonb/
├── README.md              # this file
├── meta.json              # the Document entity
├── seed.json              # 2 seed Documents (ids 1, 2), each with a jsonb object
└── scenarios/
    └── jsonb-open-bag-roundtrip.yaml
```

`seed.json` is applied fresh before the scenario; the runner advances the id
sequence past `max(id)` so the next implicit-id POST lands at id 3 (then 4),
mirroring the single-entity `create-201` contract.

## Scenario

`jsonb-open-bag-roundtrip.yaml` exercises both read and write of the open bag:

| Request | What it pins |
|---|---|
| `r1` GET `/api/documents/1` | a **seeded** jsonb object reads back as an object |
| `r2` POST `/api/documents` | the generated validator accepts a posted nested object; the create echo is an object |
| `r3` GET `/api/documents/3` | the persisted value reads back as the same object |
| `r4` POST `/api/documents` | jsonb holds any JSON — an object whose values include an **array** |
| `r5` GET `/api/documents/4` | the array-bearing structure reads back parsed (never a string) |

The `body.row` assertion deep-equals each listed key with **sorted-key**
normalization (the corpus's existing canonical form), so the gate is
object-vs-string and structure-preserving — it does not pin jsonb key order.
A regressed port that returned `"{\"k\":\"v\"}"` (a string) instead of
`{"k":"v"}` (an object) fails here.

## Per-port wiring status

Both lanes (hand-rolled reference server + the GENERATED routes/controller
booted over HTTP) are wired and green for:

- **TypeScript** — reference (`ObjectManager`) + generated (`runGen` →
  emitted `Document.routes.ts` over Postgres testcontainer).
- **Python** — reference (FastAPI + pg8000 over Postgres testcontainer) +
  generated (`render_router` emitted router + in-memory seam).
- **Kotlin** — reference (`DocumentApiServer`, Exposed `jsonb` column over a
  Postgres testcontainer) + generated (`KotlinSpringControllerGenerator` →
  emitted `DocumentController` hosted on MockMvc over a Postgres testcontainer).
  The generated lane caught + fixed a real codegen bug — a `field.string
  @dbColumnType=jsonb` field produced a controller that referenced the kotlinx
  `JsonElement` cast in its (dead) filter dispatch without importing it, so the
  controller did not compile; the open bag is now excluded from the controller's
  filter dispatch + sort allowlist (it is neither). Serialization seam: a
  `JsonElement` is a sealed polymorphic type that neither Spring JSON converter
  handles by default (vanilla Jackson can't construct it; the built-in kotlinx
  converter refuses polymorphic bodies → HTTP 415), so the Kotlin generated lane
  wires a small Jackson `JsonElement` codec module (the consumer's serialization
  wiring).

Deferred (corpus is ready; follow-up): **Java**, **C#**. Their api-contract
harnesses bind the per-entity DTO shape statically (the JVM generated harness
reflects a fixed `Author` constructor arity + ships a hand-written in-memory repo
source; the C# generated lane is full-stack EF + Kestrel), so adding the
`Document` entity means a new reference server + generated harness per port
(mirroring their `m2m/` and `tph/` sub-corpus harnesses) rather than a focused
fixture edit. Tracked in #98.
