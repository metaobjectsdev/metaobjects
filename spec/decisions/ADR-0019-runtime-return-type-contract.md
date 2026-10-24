# ADR-0019 — Runtime return-type contract: native in-process, canonicalize at the boundary

**Status:** Accepted (2026-05-31)
**Applies to:** all five language ports (TypeScript reference + Java / Kotlin / C# / Python); the runtime `ObjectManager` query-return layer.
**Related:** [ADR-0017](ADR-0017-cross-port-runtime-object-model.md) (cross-port runtime object model); the `fixtures/persistence-conformance/normalization.md` wire contract.

## Context

Every port ships a runtime `ObjectManager` (Kysely/TS, EF Core/C#, OMDB/Java, Exposed/Kotlin, SQLAlchemy-pg8000/Python) whose `find_by_id` / `find_many` return entity rows to an application. Separately, the cross-port `persistence-conformance` corpus asserts a **canonical wire form** (BIGINT→string, NUMERIC→no-trailing-zero string, temporal→the `normalization.md` forms, uuid→lowercased, jsonb→key-sorted) — the bytes a client receives over the network.

These are two different concerns, and the codebase had conflated them in one port. Java / C# / Kotlin / TS return **native in-process language types** from the runtime and apply the wire canonicalization only at the **test-harness `Normalization` seam** (the boundary). **Python uniquely applied the canonicalization *inside* the `ObjectManager` query path**, so its runtime returned **wire-strings** (`id → "1"`, `score → "50"`, a timestamp → a `str`). A Python application consuming the runtime therefore received strings it had to re-parse — surprising, inconsistent with the other four ports, and invisible to the conformance corpus (which only checks the wire form *after* canonicalization, so a string-returning runtime passes trivially).

Two further symptoms motivated writing this down as a durable contract: (1) `field.decimal` surfaced a lossy `Double`/`float` even in the "native" ports because `DecimalField` was backed by `DataTypes.DOUBLE` (Java) / `DataType.DOUBLE` (Python) — see SP-D's field-level fix; (2) nothing prevented a port from silently reverting to in-runtime canonicalization, which is exactly how Python drifted unnoticed.

## Decision

**A port's runtime `ObjectManager` returns native, in-process language types. Canonicalization to the cross-port wire form is a serialization/boundary concern — it is applied where data crosses out of the process (HTTP/JSON serialization, or, for the conformance suites, the persistence-runner `Normalization`), never baked into the runtime query path.**

Per-concept native return type:

| metamodel | native runtime type |
|---|---|
| `field.int` / `field.short` | native 32-bit integer |
| `field.long` | native 64-bit integer (TS: `number`; the BIGINT-as-number caveat for values > 2^53 is documented per-port) |
| `field.decimal` | native **exact** decimal — Java/Kotlin `BigDecimal`, C# `decimal`, Python `Decimal`; **TS `string`** (TS has no native exact-decimal type; `string` preserves precision — see the SP-A type-fidelity design) |
| `field.double` / `field.float` | native float/double |
| `field.timestamp` / `date` / `time` | native temporal type. **`field.timestamp` is instant / timezone-aware BY DEFAULT (ADR-0036 Wave 2)** → `TIMESTAMPTZ`; native `Instant` (Java/Kotlin) / `DateTimeOffset` (C#) / aware `datetime` (Python) / ISO-8601 string with `Z` (TS). **`@localTime:true` is the naive opt-out** → `TIMESTAMP`; native `LocalDateTime` / `DateTime(Unspecified)` / naive `datetime` / string. The boundary canonicalizer still distinguishes the two by the value's tz-awareness (a **timezone-aware** value → `TIMESTAMPTZ`, a **naive** value → `TIMESTAMP`, without column OIDs) — only the DEFAULT moved from naive to tz-aware. |
| `field.uuid` | native uuid type, or string where idiomatic for the port |
| `field.string` / `field.enum` | native string |
| `field.object` (structured jsonb) | native map / dict / object |

**jsonb representation is driver-dependent, by design.** For a `field.string` physically stored as jsonb (`@dbColumnType: jsonb`), the runtime returns whatever the port's DB driver natively yields: a JSON **string** under JDBC (Java OMDB, Kotlin Exposed) and EF Core; a parsed **dict/object** under pg8000 (Python) and node-postgres (TS), which auto-decode jsonb. The runtime does NOT force a uniform representation — that would mean re-parsing or re-stringifying against the driver. The boundary canonicalizer key-sorts *either* form to the same wire bytes, so the cross-port wire contract holds regardless. (A future option, if a uniform in-process jsonb shape is wanted, is to normalize at the runtime's read codec — out of scope here.) The per-port runtime-type gate asserts each port's genuine native return for this field, documenting the divergence rather than hiding it.

The wire canonicalization itself (and `normalization.md`) is **unchanged** by this ADR — only *where* it runs moves: to the boundary, never the runtime.

## Consequences

- **Python is reconciled:** `_coerce_for_contract` moves out of `ObjectManager` into Python's persistence runner, which canonicalizes **by Python type** (mirroring the other ports' by-native-type runners; tz-aware vs naive `datetime` distinguishes TIMESTAMPTZ from TIMESTAMP). Python applications now receive native `int` / `Decimal` / `datetime` / `uuid.UUID` / `dict`.
- **Gated going forward:** each port adds a runtime-return-type assertion (native, not wire-string) — a per-port contract test (native types differ per language, so it is not a byte-identical cross-port corpus). This catches the Python-outlier class of regression.
- **Decimal becomes lossless end-to-end:** with `field.decimal` surfacing `BigDecimal`/`Decimal`/`decimal` natively (SP-D field-level fix), the canonical wire string is produced from an exact value rather than a 15-digit-bounded double. The wire bytes are unchanged; the value behind them is now exact.
- **Serialization layers (generated REST, future MCP) own canonicalization.** A generated API serializing a runtime row to JSON is responsible for the wire form; the runtime hands it native types to serialize. This keeps the runtime usable as a normal data-access layer in an application, not just as a wire producer.
- **No change** to the wire format, `normalization.md`, or any persistence-corpus `expect:` block.

## Amendment 1 (2026-10-21): the decimal wire form

**Context.** This ADR placed canonicalization at the boundary and said generated REST owns it,
but never named what a decimal looks like on the HTTP wire. Each port's serializer chose for
itself. In the 1.1.0 release review the five ports sent five spellings: C#, Java and Kotlin wrote
JSON numbers carrying the engine's scale (`0.40000000000000000000`, `1E-7`, `0E-18`), Python wrote
`str(Decimal)` (`"12.50"`, `"1E-7"`), and TypeScript wrote the column's scale on Postgres and MySQL
and a lossy JS `number` on SQLite and D1 (`12345678901234567.89` read back as
`12345678901234568`). Nothing failed, because no corpus asserted a decimal value that a double
cannot hold, and four of the five api-contract assertion engines compared numbers by integer
truncation.

**Decision.** The in-process type per port is unchanged (the table above: `BigDecimal`, `decimal`,
`Decimal`, TypeScript `string`). What crosses the HTTP boundary is one rule in every port:

- **W1, emit.** Every `field.decimal` value, and every derived field typed decimal (a report's
  `avg`, a `measure.ratio`, a `sum`, `min` or `max` of a decimal), is a JSON **string** in
  canonical form, matching `^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$`: plain notation, no exponent, no
  leading `+` or zeros, no trailing fractional zeros and no bare point. Zero in any spelling
  (`-0`, `0E-18`, `0.0000`) is `"0"`. Null is `null`, with the key present. This is the
  persistence corpus's NUMERIC rule (`fixtures/persistence-conformance/normalization.md`), so the
  corpus and the HTTP wire say the same thing. A client that wants `12.50` formats with the
  field's `@scale` from metadata: the server does not format, as with `field.currency`.
  Display formatting (two digits for money, a locale's separators) is a view concern, never the
  wire's (ruled 2026-10-21, trailing-zero option A final).
- **W2, accept.** A request body (POST, PUT, PATCH) takes a decimal as a JSON string in the
  JSON-number grammar (`^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$`; an exponent is allowed
  on input only) or as a JSON number. A string is exact; a number is exact to 15 significant
  digits in every port. Anything else (`""`, surrounding whitespace, `"1,5"`, `"NaN"`,
  `"Infinity"`, `"0x10"`, a boolean) is `400 {"error": "validation"}` naming the field. A filter
  operand on a decimal uses the same grammar, is compared exactly (never through a double), and
  a malformed one is `400 invalid_filter_value`.
- **W3, range.** Nothing is rounded silently. On input, a value with more fraction digits than the
  field's `@scale`, or more integer digits than `@precision - @scale`, is `400 validation`
  (Postgres and MySQL would otherwise round the fraction, or fail with a database error). A value
  the port's exact type cannot hold is refused the same way. On read, a stored value the port's
  type cannot hold is a named error, not a rounded number (C#'s `decimal` holds 28 to 29
  significant digits). The api-contract `decimal/` scenario `decimal-write-exact` asserts the
  input half.
- **W4, the SQLite and D1 tier.** These engines have no decimal type: a text value with NUMERIC
  affinity is stored as an INTEGER or REAL, keeping only its first 15 significant digits. A
  decimal on them is exact to **15 significant digits**: the read path renders the stored double
  with 15 significant digits (SQLite's own text precision) and then canonicalizes it, so
  `sum(0.1, 0.2)` reads `"0.3"`. `meta migrate` warns when a `field.decimal` on these dialects
  declares `@precision` above 15.

A non-terminating `avg` or ratio (`1/3`) has the engine's precision and differs between engines;
no corpus asserts one.

**Why a string.** RFC 7493 (I-JSON) §2.2 recommends a string for numbers beyond a double's
precision, and the protobuf JSON mapping, `google.type.Decimal`, Shopify's `Decimal` and PayPal's
money values all use one. MetaObjects ships a browser client, and `JSON.parse` turns a number
into a double before any user code sees it, so a number spelling cannot be read exactly there.
**Why strip trailing zeros.** Engines disagree on result scale (Postgres `avg` gives 16 to 20
places, MySQL the column's scale plus 4, Exposed 18, SQLite none), so only the stripped form is
comparable across ports and engines, and it is the form the persistence corpus already used.

**Consequences.**

- Each port has one production wire helper (format and parse) that its generated routes and DTOs
  use, tested against the shared vectors in `fixtures/decimal-wire/vectors.json`.
- The persistence corpus asserts decimals in each port's own type before normalizing (a double in
  a decimal slot fails), and its `decimal-exact` scenarios use values a double cannot hold.
  Runners stop re-spelling decimals in their engine mappers, so the gate checks the runtime.
- The api-contract `decimal/` sub-corpus asserts the bytes of W1 and the refusals of W2 in every
  port's generated lane, and every assertion engine compares non-integer numbers exactly.
- TypeScript's runtime returns its declared `string` on SQLite and D1 too.
- This is a wire change for every port's generated REST surface, listed as breaking in the 1.1.0
  CHANGELOG. The wire contract is part of `metamodelVersion` (`docs/compatibility-policy.md`),
  which moves to `1.1` in the same release. An owned (ejected) route or DTO generator keeps the old
  spelling until it is resynced.

## Amendment 2 (2026-10-24): each port writes its language's standard JSON by default

**Context.** Amendment 1 made the W1 string the only output, in every port, with no opt-out, and
1.1.0 shipped it on a minor release. It also shipped a second change no amendment recorded: C#,
Java and Kotlin started leaving a value object's null member out of the JSON
(`[JsonIgnore(WhenWritingNull)]`, `@JsonInclude(NON_NULL)`), because the api-contract corpus
asserted the omitted form. For an adopter with a live API this was a breaking change to its
clients on an upgrade within one major line. A C# adopter moving from 1.0.4 to 1.1.1 had its
decimals turn from `12.50` into `"12.5"` and its null members disappear. It could only get back
by editing the generated output and deleting the helper file. The defaults had been chosen to
make five ports agree for our own conformance corpora, not to make each port do what its
language does.

**The rule.** Each port's default is its language's standard behaviour: what that language's
standard serializer writes for the port's in-process type. Identical output across ports is an
opt-in setting. Conformance corpora pin that setting explicitly and never decide a default. A
future change that would make a port's default output differ from its language's standard,
so that the ports agree, needs a new amendment that answers this one.

**Decision.** The OUTPUT form of a generated REST surface is a project setting. It sits in
`.metaobjects/config.json` beside `naming` ([ADR-0058](ADR-0058-one-physical-naming-setting.md)), and
the same config reader reads it in every port:

```json
{ "schema_version": 1, "wire": { "decimals": "native", "nullMembers": "native" } }
```

- `wire.decimals`: `"native"` (default) or `"string"`. `string` is Amendment 1's W1, exactly as
  1.1.0 and 1.1.1 wrote it. `native` writes what the port's standard serializer writes for its
  in-process decimal type, with no MetaObjects canonicalization on output.
- `wire.nullMembers`: `"native"` (default), `"emit"` or `"omit"`. It covers the members of a
  value object (`object.value`) on the wire, and therefore in the jsonb that a typed serializer
  writes. A top-level entity field is unchanged: its key is present and its value is `null`.
  `omit` leaves a null member out. `emit` writes it as `null` with its key present, including a
  member the stored value lacks. `native` is what the port's standard behaviour gives for its
  in-process value-object representation.
- An absent block or key means the default. An unknown key, an unknown value or a `wire` that is
  not an object is refused when the file is read (`ERR_BAD_ATTR_VALUE`, worded like `naming`'s
  refusals). The shared cases are in `fixtures/wire-conformance/config-blocks.json`.
- The project-aware load carries the setting on the loaded root, as `naming` is carried. Codegen
  reads it from there; there is no CLI flag and no generator argument. Every port's codegen
  drift gate (`meta verify --codegen`, `dotnet meta verify --codegen`, `mvn metaobjects:verify`,
  `metaobjects verify`) says when a different `wire` block reproduces the committed output
  exactly, instead of telling you to regenerate.
- There is deliberately no `"number"` value. In C#, Java and Kotlin, `native` already is a JSON
  number. In TypeScript (in-process `string`) and Python (`Decimal`, which Pydantic writes as a
  string), a number would be a lossy spelling the language does not use.

**Input does not follow the setting.** W2 (a decimal is a JSON string in the JSON-number grammar
or a JSON number, and anything else is `400 validation`), W3 (nothing is rounded: over-scale or
over-precision is `400 validation`), W4 (SQLite and D1 at 15 significant digits), exact filter
operands and `400 invalid_filter_value` apply in every mode. A generated input converter is kept
in every mode. Only output canonicalization, and the null-member annotation, depend on the
setting.

**What each port writes.**

| Port | `decimals: native` (default) | `decimals: string` | `nullMembers: native` (default) | `emit` | `omit` |
|---|---|---|---|---|---|
| C# | a JSON number, as System.Text.Json writes a `decimal`: its scale is kept (`12.50`, `0.0000001`) | `"12.5"` | `null`, key present | same as native | left out |
| Java | a JSON number, as the host's Jackson `ObjectMapper` writes a `BigDecimal` (Spring Boot's default: `12.50`, `1E-7`) | `"12.5"` | `null`, key present | same as native | left out |
| Kotlin | same as Java | `"12.5"` | `null`, key present | same as native | left out |
| Python | a string, as Pydantic v2 writes a `Decimal`: `str(value)` (`"12.50"`, `"1E-7"`) | `"12.5"` | as the runtime holds the value object (a dict): a stored `null` is `null`, a missing member is absent | every declared member present, `null` when unset | left out |
| TypeScript | a string, as the runtime holds it: the driver's text on Postgres and MySQL (`"12.50"`); on SQLite and D1, the stored number at 15 significant digits | `"12.5"` | as stored (`JSON.stringify`: a stored `null` is written, a missing member is absent) | every declared member present, `null` when unset | left out |

In C#, Java and Kotlin, the 1.1.2 default restores the 1.0.x output. In TypeScript and Python it
differs from 1.1.1, which also canonicalized: a decimal is again the driver's or `str(Decimal)`
spelling (`"12.50"`, not `"12.5"`). A project that wants 1.1.1's output in every port declares
`"wire": { "decimals": "string", "nullMembers": "omit" }`.

**Consequences.**

- The api-contract and persistence corpora pin the portable form in their own
  `.metaobjects/config.json` (`"wire": { "decimals": "string", "nullMembers": "omit" }`). Every
  port's generated lane reads it from there, as it reads `naming`, so the corpora keep asserting
  W1 bytes. Each port also tests that the default writes the language-standard shape on real
  serialized output of its generated code.
- A browser client that must read a decimal exactly should use `"decimals": "string"`.
  `JSON.parse` turns a number into a double before any user code sees it (Amendment 1, "Why a
  string"). That is a choice the project makes; it is no longer the default.
- No vocabulary changes, so `metamodelVersion` does not move. The fix ships in 1.1.2 as a bug fix.
