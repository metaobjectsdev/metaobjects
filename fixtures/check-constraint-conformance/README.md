# CHECK constraint conformance

The CHECK constraints `meta migrate` derives from a model, pinned by name and by expression
text, per dialect, with and without `migrate.checks.skipRedundant`. A port that declares CHECKs
in its own generated model must declare exactly these, so one model builds one database whether
`meta migrate` or the port's own migrations create it.

## Layout

- `input/meta.checks.json`: the model. `Gadget` carries one of every CHECK source: scalar enums
  (string and int-backed), an enum array (no CHECK), `validator.numeric`, `validator.length`,
  `validator.regex`, `validator.comparison` (with `@condition`), `validator.requiredWhen`,
  `validator.presentIff`, `validator.exactlyOne` and `validator.atLeastOne`, plus explicit
  `@constraintName`s. It also has a replica view, so its derived field `band` exists, and
  `band` gets no CHECK (nor does the `requiredWhen` that names it). `Parcel` adds an
  `origin.passthrough` field (`ownerName`, from `Owner.name`) that carries a length validator:
  a derived field is no column, so it gets no CHECK either.
- `expected.<dialect>.json`: `{ "<table>": [{ "name", "expression" }] }` for every table with a
  CHECK, in the order `meta migrate` emits them. `postgres`, `sqlite` and `d1` (SQLite and D1 are
  identical), and `*.skip-redundant.json` for `migrate.checks.skipRedundant: true`.

## Runners

- TypeScript: `server/typescript/packages/migrate-ts/test/check-constraint-conformance.test.ts`
  builds the expected schema with `buildExpectedSchema` and compares each file. It is the reference:
  `META_WRITE_CHECKS=1 bun test test/check-constraint-conformance.test.ts` (in `migrate-ts`)
  rewrites the files after a deliberate change, which is then reviewed by hand.
- C#: `server/csharp/MetaObjects.Codegen.Tests/CheckConstraintConformanceTests.cs` reads the
  `HasCheckConstraint` declarations the generated EF context makes and compares them with the
  same files. `MetaObjects.IntegrationTests` also creates the schema with `EnsureCreated` on a
  live Postgres and checks the constraint names and that a violating row is refused.

Java, Kotlin and Python declare no CHECK in a generated model (schema comes from `meta migrate`,
ADR-0015), so they do not run it.
