# codegen-conformance / abstract

Shared input for the cross-port "honor `abstract` in codegen" guarantee. Each port's
own test suite loads `input/meta.abstract.json` and asserts (idiomatically — no
byte-identical cross-language expectation):

- **AbstractRecord** (`abstract: true`, has a `source.rdb` table): produces NO
  instance/write artifact — no table `abstract_records`, no routes/controller, no
  repository, no filter allowlist, no DbSet/registry entry, no `CREATE TABLE`.
- **BaseShape** (`abstract: true`, no source): same suppression. In Python it still
  emits a Pydantic base model (Widget subclasses it).
- **Widget** (concrete, `extends BaseShape`, own `source.rdb`): produces its full set of
  artifacts (table `widgets`, routes, repo, allowlist on `sku`) with inherited fields
  `id` + `name` present. Python: `class Widget(BaseShape)`.

The shape knob (`emitAbstractShapes`, default off for the flatten ports C#/Java/Kotlin):
when OFF the abstract entities produce no shape artifact; when ON exactly one standalone
abstract class/interface each, still no instance/write artifact. Python's default is on
(its concretes subclass the abstract base model).

See `docs/superpowers/specs/2026-05-29-abstract-codegen-honoring-cross-port-design.md`.
