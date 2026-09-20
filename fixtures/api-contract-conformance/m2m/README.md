# `api-contract-conformance/m2m/` — FR-018 many-to-many traversal corpus

Cross-port REST contract for **M:N relationship traversal** over HTTP. A source
entity with a `@cardinality: "many"` + `@through` relationship exposes the
related collection as a sub-resource:

```
GET {prefix}/<source-plural>/:id/<relationName>   →  the related target rows
```

Three plain resolution modes, one scenario each — the three original scenarios,
which still mirror the persistence-conformance `m2n-*.yaml` corpus exactly (same
entities, seed rows and expected results). The five TPH x M:N scenarios below
extend the model with a TPH hierarchy and four more junctions:

| Scenario | Mode | Route |
|---|---|---|
| `m2m-hetero-traversal` | hetero (`Post` —`tags`→ `Tag` via `PostTag`) | `GET /api/posts/:id/tags` |
| `m2m-directed-self-join-traversal` | directed self-join (`Person` —`following`→ `Person` via `Follow`, `@sourceRefField`) | `GET /api/persons/:id/following` |
| `m2m-symmetric-self-join-traversal` | symmetric self-join (`Person` —`friends`→ `Person` via `Friendship`, `@symmetric`) | `GET /api/persons/:id/friends` |

The URL segment for the source is its **entity name `snake_case`d and then
pluralized** (`Person` → `/persons`, `Post` → `/posts`, `PostCategory` →
`/post_categories`), per the cross-port grammar — NOT the physical `@table`. The
relation segment is the relationship `name`. Every source above is a single
regular word, where snake_casing and pluralizing are both no-ops; see
"Collection-URL spelling" for the case that is not.

## TPH x M:N (FW-8)

The `tph/` corpus declares **no relationships** and this one originally declared
**no discriminators** — they were built disjoint, which is exactly how a whole
defect class (an M:N inside a single-table hierarchy getting no route at all,
while everything still compiled) survived every green lane. These five scenarios
close that gap by gating the two features *together*.

The model adds `Account` (TPH base, `@discriminator: "kind"`), an ABSTRACT mid
level `ScopedAccount`, and concrete `MemberAccount` / `GuestAccount`.

| Scenario | Case it is the only cover for |
|---|---|
| `tph-m2m-base-declared-traversal` | M:N declared on the discriminator BASE. Serves at the base path for a row of **any** subtype (rule a), and the same inherited relation ALSO mounts under each subtype segment (rule b) — the overlap is deliberate and the independent oracle requires it. |
| `tph-m2m-subtype-declared-traversal` | M:N declared on a CONCRETE SUBTYPE. Got no route at all before the fix. |
| `tph-m2m-abstract-mid-declared-traversal` | M:N declared on an ABSTRACT MID LEVEL. The abstract level is never served itself, so this serves under the concrete subtype's segment or it serves **nowhere** — which is what mounting an inherited M:N only at the base would have caused. |
| `tph-m2m-onto-subtype-target` | TARGET-side narrowing: a non-subtype source (`Post`) onto a TPH subtype (`MemberAccount`). `post_reviewers` deliberately links post 2 to account 2, a **Guest** — a port that fails to narrow the target returns that sibling's row instead of `[]`. |
| `tph-m2m-cross-subtype-source-empty` | SOURCE-side rule (c): a Guest id through the `/member/` segment is `200` with an EMPTY list — never 404, never a sibling's rows. Without the gate the junction FK addresses the shared base table, so a sibling id would traverse it just as well and the segment would be decorative. |

Source-side and target-side narrowing are **independent axes**: one gates the id
before the join, the other filters rows after it. A port can implement either
without the other, so both are gated separately.

`ScopedAccountTag`'s `identity.reference` names **ScopedAccount** — the DECLARING
entity. Pointing it at `MemberAccount` is refused by the M:N derivation, whose
subject set is `{declaring entity, navigating entity}`.

## Collection-URL spelling (`PostCategory`)

`PostCategory` takes part in no relationship. It is here because this corpus was the
only one with a per-entity seed and a multi-entity route lane, and the spelling of a
collection URL had nowhere else to be gated.

The rule: the segment is the **entity name**, `snake_case`d and then pluralized, so
`PostCategory` is served at `/api/post_categories`. Two divergence axes meet on this
one name and nowhere else in any corpus:

| Axis | What it catches | Wrong spelling |
|---|---|---|
| word separation | lowercasing a multi-word name without separating it | `/postcategories` |
| pluralization | appending a naive `"s"` instead of `y` → `ies` | `/postcategorys` |

`route-spelling-multiword-collection` asserts the correct path serves the rows **and
that both wrong spellings 404** — so a port that mounts the new path while leaving its
old one in place fails too. Its `@table` is `blog_categories`, deliberately unlike both
the route and the entity name, so no port can pass by echoing the table.

Every other collection base in the corpus is a single regular word (`/posts`, `/tags`,
`/accounts`, and `/authors` in the core corpus), where all five ports' rules coincide —
which is exactly how four different spellings shipped green.

## Files

```
m2m/
├── README.md              # this file
├── meta.json              # Post/Tag/PostTag + Person/Follow/Friendship
│                          #   + Account/ScopedAccount/MemberAccount/GuestAccount
│                          #   + AccountTag/ScopedAccountTag/MemberAccountTag/PostReviewer
│                          #   + PostCategory (route spelling only — no relationship)
├── seed.json              # rows for every table, applied fresh per scenario
└── scenarios/
    ├── m2m-hetero-traversal.yaml
    ├── m2m-directed-self-join-traversal.yaml
    ├── m2m-symmetric-self-join-traversal.yaml
    ├── tph-m2m-base-declared-traversal.yaml
    ├── tph-m2m-subtype-declared-traversal.yaml
    ├── tph-m2m-abstract-mid-declared-traversal.yaml
    ├── tph-m2m-onto-subtype-target.yaml
    ├── tph-m2m-cross-subtype-source-empty.yaml
    └── route-spelling-multiword-collection.yaml
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
