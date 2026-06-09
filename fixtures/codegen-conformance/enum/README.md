# codegen-conformance / enum

Shared input for the cross-port "emit `field.enum` faithfully in codegen" guarantee.
Each port's own test suite loads `input/meta.enum.json` and asserts (idiomatically — no
byte-identical cross-language expectation) that the entity's enum fields are represented
with the correct, string-backed value sets.

- **Priority** (root-level `field.enum`, `abstract: true`, `@values` LOW/MEDIUM/HIGH):
  a reusable abstract enum — declares the member set once for reuse via `extends`.
- **Ticket** (concrete entity, table `tickets`):
  - `status` — an **inline** `field.enum` with its own `@values` OPEN/PENDING/CLOSED.
  - `priority` — `extends Priority`, inheriting LOW/MEDIUM/HIGH (the "abstract enum +
    extends" reuse path; ports that materialize a shared enum dedupe on the super name).

What each port asserts against its own generated entity/model code:

| Port | Enum representation |
|---|---|
| **TypeScript** | a string union type + `z.enum([...])` validator |
| **C#** | a nested/standalone `enum` + EF `HasConversion<string>()` |
| **Java/Spring** | a Java `enum` (deduped) on the payload/DTO |
| **Kotlin** | a standalone `enum class` |
| **Python** | a Pydantic `Literal[...]` member set |

The DB `CHECK ( ... IN (...) )` constraint is asserted **TS-side only** — schema
migrations are TS-owned (ADR-0015); the other ports are pure data-access.

The shared input means drift between ports surfaces as a divergent per-port assertion
against the same metadata, while each assertion stays idiomatic to its target.
