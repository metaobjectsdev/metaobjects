# `api-contract-conformance/m2m/` — FR-018 many-to-many traversal corpus

Cross-port REST contract for **M:N relationship traversal** over HTTP. A source
entity with a `@cardinality: "many"` + `@through` relationship exposes the
related collection as a sub-resource:

```
GET {prefix}/<source-plural>/:id/<relationName>   →  the related target rows
```

Three resolution modes, one scenario each (mirrors the persistence-conformance
`m2n-*.yaml` corpus exactly — same entities, same seed, same expected results):

| Scenario | Mode | Route |
|---|---|---|
| `m2m-hetero-traversal` | hetero (`Post` —`tags`→ `Tag` via `PostTag`) | `GET /api/posts/:id/tags` |
| `m2m-directed-self-join-traversal` | directed self-join (`Person` —`following`→ `Person` via `Follow`, `@sourceRefField`) | `GET /api/persons/:id/following` |
| `m2m-symmetric-self-join-traversal` | symmetric self-join (`Person` —`friends`→ `Person` via `Friendship`, `@symmetric`) | `GET /api/persons/:id/friends` |

The URL segment for the source is its **entity name pluralized** (`Person` →
`/persons`, `Post` → `/posts`), per the cross-port grammar — NOT the physical
`@table`. The relation segment is the relationship `name`.

## Files

```
m2m/
├── README.md              # this file
├── meta.json              # 6-entity model: Post/Tag/PostTag + Person/Follow/Friendship
├── seed.json              # rows for all six tables, applied fresh per scenario
└── scenarios/
    ├── m2m-hetero-traversal.yaml
    ├── m2m-directed-self-join-traversal.yaml
    └── m2m-symmetric-self-join-traversal.yaml
```

The junction FK columns are **derived** from each junction entity's two
`identity.reference` children (the SSOT for FK direction) — the relationship
never restates them. Hetero matches each reference by the entity it resolves to;
directed self-join uses `@sourceRefField` to pick the source side; symmetric
unions both junction FK columns on read (`WHERE srcFK = :id OR tgtFK = :id`),
returning the non-source column per row.

## Scenario shape + assertions

Identical to the parent `api-contract-conformance` corpus
([`../README.md`](../README.md)), with one added body assertion for M:N:

| Key | Meaning |
|---|---|
| `namesUnordered` | the response is an array; assert the multiset of `name` fields (order-insensitive — related-row order through a junction is not contractually fixed) |

`length: 0` asserts an empty related collection (orphan source / direction-aware
miss).

## Both lanes (the cross-port gate)

Each port runs these scenarios in **two lanes**, matching the SP-F generated
fan-out:

1. **Reference lane** — a hand-rolled server traversing the joins directly.
2. **Generated lane** — the port's EMITTED M:N traversal route booted over HTTP
   (the deployed artifact, not a stand-in).

TS reference runner: `server/typescript/packages/integration-tests/test/api-contract-m2m.test.ts`
(both lanes; one Testcontainers Postgres per scenario per lane). Other ports
mirror against this corpus in Units 11–14.

> **codegen-conformance note.** A dedicated cross-port codegen-OUTPUT corpus
> (FR-007) was **formally rejected** — see
> [`../../codegen-conformance/README.md`](../../codegen-conformance/README.md).
> M:N codegen is therefore gated by THIS api-contract corpus (REST behavior of
> the emitted route) plus the persistence-conformance `m2n-*` corpus (runtime
> resolver), not by a semantic-manifest corpus. Adding M:N to a behavior corpus
> is the project's standard way to gate new codegen.
