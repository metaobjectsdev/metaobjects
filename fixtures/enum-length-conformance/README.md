# Enum-length conformance

A string-stored `field.enum` is a `VARCHAR(n)` column when it has a length: its own `@maxLength`,
else the project's default, `"enums": { "maxLength": n }` in `.metaobjects/config.json`. With
neither it stays an unbounded text column, as before. An `@intValueMap` enum is an integer
column and takes no length. Every member must fit: the loader refuses an `@maxLength` a member
is longer than (`ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH`, pinned in `fixtures/conformance/`), and the
core resolver refuses a member longer than the project default, so every consumer that sizes
the column refuses the same model.

[`cases.json`](./cases.json) holds the `enums` blocks every port must accept, with the length
each enum in [`meta.enums.json`](./meta.enums.json) resolves to under them, the overflow every
port must refuse, and the blocks every port must refuse when it reads the file. A whole
number is accepted however JSON spells it (`32`, `32.0`, `1e2`), because a JSON reader that
parses numbers as doubles cannot tell those apart. Each port runs
it through its own config reader and core resolver:

| Port | Test |
|---|---|
| TypeScript | `server/typescript/packages/sdk/test/enum-length-conformance.test.ts` |
| C# | `server/csharp/MetaObjects.Codegen.Tests/EnumLengthConformanceTests.cs` |
| Java / Kotlin | `server/java/metadata/src/test/java/com/metaobjects/database/EnumLengthConformanceTest.java` |
| Python | `server/python/tests/conformance/test_enum_length_conformance.py` |

The column each port's bindings emit is described in
[`docs/features/field-types.md`](../../docs/features/field-types.md).
