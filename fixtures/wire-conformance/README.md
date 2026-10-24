# Wire conformance

The `wire` block of `.metaobjects/config.json` (ADR-0019 Amendment 2) chooses the OUTPUT form of
a generated REST surface: how a `field.decimal` is written, and whether a value object's null
member is written. The default is `native` for both keys, which means each port writes what its
language's standard serializer writes. `"decimals": "string"` and `"nullMembers": "omit"` give
identical output across the five ports; the api-contract and persistence corpora pin exactly
that form in their own `.metaobjects/config.json`.

[`config-blocks.json`](./config-blocks.json) holds the blocks every port must accept, with the
values they resolve to, and the blocks every port must refuse when it reads the file. Each port
runs it through the same config reader it uses for `naming`:

| Port | Test |
|---|---|
| TypeScript | `server/typescript/packages/sdk/test/wire-conformance.test.ts` |
| C# | `server/csharp/MetaObjects.Codegen.Tests/WireConformanceTests.cs` |
| Java / Kotlin | `server/java/metadata/src/test/java/com/metaobjects/config/WireConformanceTest.java` |
| Python | `server/python/tests/conformance/test_wire_conformance.py` |

The per-port output of each setting is tabled in
[`docs/features/api-contract.md`](../../docs/features/api-contract.md#the-wire-setting).
