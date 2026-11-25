# response-verify-conformance

Pins what the template drift gate (`meta verify --templates` and each port's counterpart)
reports about a prompt's **reply** — the `@responseRef` value object a model's answer is
parsed into.

```
cases.json   # { cases: [{ name, note?, metadata, expect: [{ template, code, path, severity }] }] }
```

Each case's `metadata` is one canonical-JSON file. Load it, and for every `template.*` node
collect the reply findings; `expect` is the **exhaustive** list, compared as an unordered set.

| Code | Severity | Raised when | `path` |
|---|---|---|---|
| `ERR_RESPONSE_UNRESOLVED` | error | a `template.prompt` carries `@responseRef` and the reply resolves to no loaded value shape with at least one field | the `@responseRef` value |
| `ERR_RESPONSE_TAG_UNDECLARED` | warning | `@responseFormat: xml`, and a `@requiredTags` entry is neither the reply type's short name nor the name of a field anywhere in the reply tree (nested value objects included) | the tag |

`@responseRef`, `@responseFormat` and `@requiredTags` are read **resolving** (ADR-0039): a
prompt that inherits them through `extends` is checked with the inherited values. A prompt
with no `@responseRef`, and a json prompt's tags, produce nothing here. The body checks the
gate already runs (`ERR_OUTPUT_TAG_MISSING`, `ERR_REQUIRED_SLOT_UNUSED`, …) are not part of
this corpus.

Runners: TypeScript `server/typescript/packages/cli/test/response-verify-conformance.test.ts`
(reference implementation) and one per port that ships a template gate (Rust's is `server/rust/metaobjects-cli/tests/response_verify_conformance.rs`). See
`docs/CONFORMANCE.md`.
