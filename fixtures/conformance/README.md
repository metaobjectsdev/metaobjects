# Conformance Corpus

Language-neutral fixtures that define the metaobjects standard's behavior. Every
language port runs every fixture through its own adapter. The corpus is the
contract — see
`metaforge/docs/superpowers/specs/2026-05-17-cross-language-conformance-harness-design.md`.

## A scenario directory

```
<scenario>/
├── input/*.json          # metadata under test (one shared copy)
├── providers.json        # optional — provider ids to compose (default: ["metaobjects-core-types"])
├── expected.json         # optional — golden canonicalSerialize of the resolved tree
├── expected-effective.json  # optional — golden canonicalSerialize of the effective tree
├── expected-errors.json  # optional — list of { "code": "ERR_*" } the load must produce
└── script.json           # optional — operation-script: API-surface checks
```

A scenario runs whatever checks its expectation files declare. A fixture with
only `expected.json` is a behavioral fixture; one with `script.json` adds
API-surface checks; a fixture may have both.

## script.json

```json
{
  "operations": [
    { "navigate": ["object:Program", "field:weekCount"],
      "invoke": "field.is-required",
      "expect": { "scalar": false } }
  ]
}
```

- `navigate` — path segments `type:name`, or `type[subType]` for nameless nodes.
- `invoke` — a capability-id, `<type>.<capability>` (kebab-case).
- `args` — optional flat map of scalar arguments.
- `expect` — a normalized result (see below).

## Normalized result vocabulary

| Kind | Meaning |
|---|---|
| `{ "names": [...] }` | ordered node-name list |
| `{ "name": "..." }` | a single node |
| `{ "absent": true }` | null / None / Optional.empty / undefined |
| `{ "scalar": <value> }` | string / number / boolean |
| `{ "subtype": "..." }` | a node's subtype |
| `{ "effective-tree": "<canonical string>" }` | a resolved subtree, canonical-serialized |
| `{ "error": { "code": "ERR_*" } }` | the invocation surfaced an error |

## Error codes

Fixtures assert error *codes*, never message prose. Codes are registered in
`ERROR-CODES.json`. Adding a code is an additive edit to that file.

## Adding a fixture

Create a directory; add `input/` and expectation files. No runner code changes —
discovery is automatic. A new fixture a port cannot yet pass goes in that port's
`conformance-expected-failures.json` ledger.
