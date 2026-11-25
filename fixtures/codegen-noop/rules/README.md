# Business-rules vocabulary: inert in every generator (ADR-0066)

Two models that differ ONLY by the business-rules vocabulary:

- `without/meta.purchasing.json`: the entity `PurchaseRequest` with its `status` enum, the
  value `DecisionInput` and the view-backed projection `RequestSummary`.
- `with/meta.purchasing.json`: the same model plus three `transition.action` children on
  `PurchaseRequest.status` and the `api.operational` `Purchasing`, whose three operations
  (one carrying a `binding.rest`) take those objects as input and output. It is derived from the
  positive conformance fixture `fixtures/conformance/rules-purchase-request/`.

1.3.0 registers the vocabulary, validates it at load and checks it in `verify`. Apart from the
generators named below that read it (the rules names, the contract types and the TypeScript
service generators `service`, `service-routes` and `service-routes-hono`), the two models
produce the same output everywhere:

- Every code generator in every port writes the same files, byte for byte.
- TypeScript `meta migrate` proposes the same schema.
- Every documentation generator writes the same pages, with one exception: the TypeScript
  model explorer (`docs-site`) lists every node of the model in its data payload, so it
  lists the `api`, `operation`, `binding` and `transition` nodes as well. Its other output
  is byte-identical, and its payload gains only lines of those four types.

The generators of the rules layers themselves (ADR-0067) are the other exception: reading this
vocabulary is their job. Each adds only files of its own for `with/`, and moves none of what it
writes for `without/`. Today those are TypeScript's `rules-names`, which writes nothing for
`without/`, and `contract-types`, whose entity contracts do not depend on the vocabulary and whose
operations module (and the value object only an operation reaches) does. In Rust, `rules-names`
and `contract-types` write nothing for `without/` and, for `with/`, only files of their own. The
Rust data-access generator (`repository`, ADR-0067 layer 3) writes the same files for both models,
because it stores every entity either way; the vocabulary changes only the file of the entity that
holds the lifecycle, and only by appending that lifecycle's guarded update (`transition_status`) at
its end.

The service generators (ADR-0067 layers 4 and 5) are the enforcing shells, so they also CHANGE
files they write for `without/`: TypeScript's `service` adds a file per derived transition command
and per declared operation and changes the package index (its policy, bodies and interfaces) and
the lifecycle entity's create and update (which check its state), and `service-routes` and `service-routes-hono` change their
transports (the new routes). The test pins both lists, and every other file stays byte-identical.
The Rust `service` adds the declared operations' file and changes the service crate's manifest
(the rules and contract crates it names), its library (the policy, the bodies and the move types)
and the lifecycle entity's file (its commands and state checks); every other file it writes changes
only in its `impl` header, which gains the policy and bodies type parameters.

A generator that started reading an operation or a transition by accident would emit
something half-built; these tests are what notice:

| Port | Test |
|---|---|
| TypeScript | `server/typescript/packages/cli/test/unit/rules-inert.test.ts` (codegen + migrate) |
| C# | `server/csharp/MetaObjects.Codegen.Tests/RulesInertTests.cs` |
| Java | `server/java/codegen-spring/src/test/java/com/metaobjects/generator/spring/RulesInertTest.java` |
| Kotlin | `server/java/codegen-kotlin/src/test/kotlin/com/metaobjects/generator/kotlin/RulesInertTest.kt` |
| Python | `server/python/tests/test_rules_inert.py` |
| Rust | `server/rust/metaobjects-codegen/tests/rules_inert.rs` (every flat generator it ships; the rules-layer generators are held to adding files only, the data-access generator to appending the guarded update, and the service to its pinned changes) |

Regenerate `without/` from `with/` by deleting every `transition.*` child and the
`api.operational` node, nothing else.
