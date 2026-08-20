# `api-docs-cross-port` — the polyglot doc-tree LAYOUT contract

`expected-paths.json` is the shared contract every port's api-docs surface asserts
against, so the polyglot doc tree coheres: a `model` page links to `api/ts` AND
`api/java` AND `api/csharp` AND `api/python` AND `api/kotlin`, and each api page links
back to the same model page with hrefs that resolve identically on disk.

The manifest is **byte-gated across five ports**. Edit `input/meta.json` and the
manifest in ONE pass, then run every runner — a half-edit reddens all five:

| Port | Runner |
|---|---|
| TypeScript | `packages/codegen-ts/test/golden/api-docs-cross-port-conformance.test.ts` (also the ORACLE — `UPDATE_CONTRACT=1 bun test <that file>` regenerates the manifest) |
| C# | `MetaObjects.Codegen.Tests/ApiDocsCrossPortConformanceTests.cs` |
| Java | `codegen-spring/.../apidocs/ApiDocsCrossPortConformanceTest.java` |
| Kotlin | `codegen-kotlin/.../apidocs/ApiDocsCrossPortConformanceKtTest.kt` |
| Python | `tests/conformance/test_api_docs_cross_port_conformance.py`, plus the symbol-level `tests/codegen/test_api_docs_builder.py` |

## The model carries BOTH template directions, deliberately

[ADR-0052](../../../spec/decisions/ADR-0052-template-direction-outbound-vs-inbound.md)
makes a template subtype's axis DIRECTION, and this corpus covers both halves:

* **`OrderSummary`** — a `template.output`. OUTBOUND: it renders a document and
  generates nothing that reads a model's reply. Its api unit is the render helper plus
  the payload record that helper binds.
* **`OrderAdvice`** — a responding `template.prompt` (`@responseRef:
  acme::shop::OrderAdviceResponse`). INBOUND: the response record, the FR-010
  response-format fragment, the parser-on-receipt and the tolerant extractor.

It carries `@format: "text"` with `@responseFormat: "json"` on purpose: `@format` is the
syntax of the rendered prompt BODY and `@responseFormat` (ADR-0053) is the syntax of the
REPLY. A port that reads `@format` to decide how to parse the answer gets this case
wrong, which is the defect the old tier shipped.

`OrderAdvicePayload` (the request it renders) and `OrderAdviceResponse` (the reply it
parses) share no field name, so a port binding the wrong ref produces visibly wrong
documentation rather than coincidentally-correct documentation.

## Why the prompt was ADDED rather than swapping the output over

Before ADR-0052, `OrderSummary` carried `@promptStyle: "inline"`, and that one attribute
made it exercise the PROMPT and OUTPUT_PARSER symbol paths in every port's api-docs
builder. ADR-0053 makes `@promptStyle` prompt-only vocabulary, so it had to come off the
output — and with it went every bit of inbound coverage this corpus had.

**Nothing failed.** All five ports stayed green, because a corpus that stops exercising a
code path produces no diagnostic at all: there is no assertion whose subject has gone
missing, only assertions that quietly cover less. The durable lesson is general — *when a
shared corpus loses a case's coverage, no test fails* — and the mitigation is to state in
this file which case covers which path, so a future edit that removes one has to remove
its stated purpose too.

So: keep both nodes. `OrderSummary` is the outbound control (asserting the inbound
symbols are ABSENT is what proves the direction rule discriminates); `OrderAdvice` is the
inbound case.
