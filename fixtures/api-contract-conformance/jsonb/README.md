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

The single `Document` entity (`acme::store`, `@table="documents"`) carries an
open-bag field plus three value-object columns:

| Field            | Type                                                      | Notes                                    |
|------------------|----------------------------------------------------------|------------------------------------------|
| `id`             | `field.long`                                             | `identity.primary @generation=increment` |
| `title`          | `field.string`                                           | `@required` + `@maxLength 200`           |
| `payload`        | `field.string @dbColumnType=jsonb`                       | open JSON bag — parsed value over the wire |
| `primaryMarker`  | `field.object @objectRef=Marker @storage=jsonb @required`| required single VO — present-null → 400   |
| `optionalMarker` | `field.object @objectRef=Marker @storage=jsonb`          | nullable single VO — FR-035 tristate      |
| `markers`        | `field.object @objectRef=Marker @storage=jsonb isArray`  | nullable array of VO — `[]` ≠ null        |

The `Marker` value object (`object.value`) is `{ label: field.string @required
@maxLength 40; score: field.int }` — so a nested-constraint violation
(`null` / `""` / label > 40 chars) is a 400.

`source.rdb @table="documents"` → the URL segment is `/api/documents`
(lowercased + pluralized), per the cross-port grammar.

## Files

```
jsonb/
├── README.md              # this file
├── meta.json              # the Document entity + Marker value object
├── seed.json              # 2 seed Documents (ids 1, 2), jsonb object + VO columns
└── scenarios/
    ├── jsonb-open-bag-roundtrip.yaml   # open-bag parsed-value contract
    └── jsonb-value-object-patch.yaml   # Program D — cross-port VO-column PATCH/POST
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

## Scenario — `jsonb-value-object-patch.yaml` (Program D)

Cross-port PATCH/POST parity for value-object jsonb columns. Every mutation is
re-read via GET to convict persistence (the C#/Kotlin generated lanes boot
full-stack over Testcontainers Postgres). Coverage:

| Requests | What it pins |
|---|---|
| `r1` GET | a seeded row surfaces required + optional single VO and an array-of-VO as parsed objects/arrays |
| `r2`/`r3` POST + GET | POST valid single + array VO → 201 → persisted read-back |
| `r4` POST | nested-constraint violation (label > 40) on CREATE → 400 |
| `r5` POST | missing the required VO column → 400 |
| `r6`/`r7` PATCH + GET | PATCH present single VO → 200 → persisted |
| `r8`/`r9` PATCH + GET | PATCH present array VO → 200 → persisted |
| `r10` PATCH | nested-constraint violation in an array element → 400 |
| `r11`/`r12` PATCH + GET | present-null on nullable single → cleared |
| `r13`/`r14` PATCH + GET | present-`[]` on array → empty array persists (`[]` ≠ null) |
| `r15`/`r16` PATCH + GET | present-null on array → null (distinct from `[]`) |
| `r17`/`r18` PATCH + GET | absent VO keys → untouched (title-only PATCH) |
| `r19` PATCH | present-null on the **required** VO column → 400 (metadata-driven) |
| `r20` PATCH | nested-member-null on the required VO → 400 (validation recurses) |

Byte-identical across TS / Python / Java / Kotlin / C#, both lanes.

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
- **C#** — reference (hand-rolled `HttpListener` over Postgres testcontainer) +
  generated (the real `MetaObjects.Codegen` `DocumentRoutes` + `AppDbContext`
  Roslyn-compiled and booted full-stack on Kestrel over Postgres testcontainer).
  The generated lane locks the #105 codegen: the `payload` property is typed
  `System.Text.Json.JsonDocument` (Npgsql ↔ jsonb native), so a posted object
  binds with no string validator and round-trips parsed.
- **Java** — reference (`JsonbReferenceServer`: JDK `HttpServer` + Postgres
  testcontainer) + generated (`GeneratedJsonbControllerHarness`: codegen-spring
  `DocumentController`/`DocumentDto` compiled and booted over MockMvc behind the
  in-memory repo seam). The generated DTO types the bag as `Object` (#103). The
  runtime/OMDB write half is gated separately by
  `integration-tests/.../OpenJsonbWriteRoundtripTest` (writes the open bag
  through `ObjectManagerDB.createObject` and reads it back parsed).

All five ports are now wired and green — both lanes each. The jsonb open-bag
parsed-value contract is locked cross-port at the api-contract boundary.
