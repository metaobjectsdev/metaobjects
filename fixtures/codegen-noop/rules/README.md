# Business-rules vocabulary: inert in every generator (ADR-0063)

Two models that differ ONLY by the business-rules vocabulary:

- `without/meta.purchasing.json`: the entity `PurchaseRequest` with its `status` enum, the
  value `DecisionInput` and the view-backed projection `RequestSummary`.
- `with/meta.purchasing.json`: the same model plus three `transition.action` children on
  `PurchaseRequest.status` and the `api.operational` `Purchasing`, whose three operations
  (one carrying a `binding.rest`) take those objects as input and output. It is the positive
  conformance fixture `fixtures/conformance/rules-purchase-request/`.

1.3.0 registers the vocabulary, validates it at load and checks it in `verify`. The
generated services and enforcing shells that act on it are later work, so until they land
the two models produce the same output everywhere:

- Every code generator in every port writes the same files, byte for byte.
- TypeScript `meta migrate` proposes the same schema.
- Every documentation generator writes the same pages, with one exception: the TypeScript
  model explorer (`docs-site`) lists every node of the model in its data payload, so it
  lists the `api`, `operation`, `binding` and `transition` nodes as well. Its other output
  is byte-identical, and its payload gains only lines of those four types.

A generator that started reading an operation or a transition by accident would emit
something half-built; these tests are what notice:

| Port | Test |
|---|---|
| TypeScript | `server/typescript/packages/cli/test/unit/rules-inert.test.ts` (codegen + migrate) |
| C# | `server/csharp/MetaObjects.Codegen.Tests/RulesInertTests.cs` |
| Java | `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/RulesInertTest.java` |
| Kotlin | `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/RulesInertTest.kt` |
| Python | `server/python/tests/test_rules_inert.py` |

Regenerate `without/` from `with/` by deleting every `transition.*` child and the
`api.operational` node, nothing else.
