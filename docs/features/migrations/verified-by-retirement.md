# Migration — the requirement vocabulary becomes prescriptive-only (`0.24.0` / Maven `7.24.0`)

**Breaking.** Four pieces of `requirement.*` vocabulary are retired in one change:

| retired | now fails with |
|---|---|
| `@verifiedBy` | `ERR_UNKNOWN_ATTR` |
| `@supersededBy` | `ERR_UNKNOWN_ATTR` |
| `@status: abandoned` | `ERR_BAD_ATTR_VALUE` |
| `@status: superseded` | `ERR_BAD_ATTR_VALUE` |

Under the strict, sealed registry (ADR-0023) there is no deprecation shim — metadata still
carrying any of them fails the **load**, in every language port. `@status` is now a closed set
of three: **`planned | live | partial`**.

## The rule behind all four

**A requirement is PRESCRIPTIVE. It states what should be true; it is never a journal of what
happened.**

Two shipped statements had come to contradict each other about the same vocabulary, and both
were load-bearing. The registry justified the dangling-`@implementedBy` exemption on
`abandoned`/`superseded` because those nodes "are meant to be gone, and that is the entry
doing its job"; the authoring guidance added that deleting such an entry "destroys the
record". §4 of the FR-038 design says a requirement "is not a record of what happened". Only
one of those could be the rule. This is the resolution.

## What to do

### 1. Delete `@verifiedBy` and `@supersededBy`

No replacement attribute — do not move the value anywhere.

```jsonc
{ "requirement.functional": {
    "name": "OrderRecord", "@level": 4, "@status": "live",
    "@statement": "An order records what was bought and for how much",
    "@violation": "An order row that cannot say who placed it",
    "@implementedBy": ["acme::shop::Order"],
-   "@verifiedBy": ["OrderServiceTest"],
-   "@supersededBy": "OrderRecordV2"
}}
```

If your `metaobjects.config.ts` declares `verify: { testFiles: [...] }`, delete that too — it
existed only for the retired scan, and the `VerifyConfig` type is gone from
`@metaobjectsdev/codegen-ts`. Two diagnostics disappear with it:
`ERR_REQUIREMENT_TEST_MISSING` and `WARN_REQUIREMENT_TEST_COMMENT_ONLY`. A build failing on
the first now passes.

### 2. Delete every `abandoned` / `superseded` requirement outright

Not "change its status" — **delete the node**. That is the whole point: the entry recorded
history, and history is not what a requirement is for.

**Where the record goes**, because this is the part adopters resist:

- **Version control** holds that the capability existed and when it went. `git log -- <path>`
  answers it precisely, and unlike a stale ledger entry it cannot drift.
- **`notes`** on a *surviving* entry holds anything a reader of today's model still needs —
  why it went, what replaced it, what not to reintroduce. One adopting estate reached this
  shape independently before the ruling, moving retirement history out of `@implementedBy`
  and into `notes` prose on the grounds that "what used to implement a retired capability is
  real information in the wrong field".

```jsonc
{ "requirement.functional": {
    "name": "BeatProgression", "@level": 4, "@status": "live",
    "@statement": "A scene advances when its beat completes",
    "@violation": "A scene that advances with its beat unresolved",
    "notes": "Replaced the per-turn wall-clock timer retired in 2026-06; do not reintroduce clock-driven pacing — it advanced scenes with beats unresolved.",
    "@implementedBy": ["game::turn::BeatProgression"]
}}
```

### 3. Expect the dangling references those statuses were hiding

This is the part that surprises people, and it is the reason the change is worth making.

`verify` was **silent** on unresolved `@implementedBy` refs on exactly those two statuses.
One adopting estate was found holding **29 refs that could never resolve, across 14 entries**,
with `meta verify` reporting zero dangling refs — true and incomplete at the same time. After
this change those entries are gone, so the refs go with them. If you convert rather than
delete, you will surface them as `ERR_REQUIREMENT_DANGLING_REF`, which is the correct signal.

## Migration cost, measured

Across three adopting estates of 262, 75 and 288 entries:

| | `abandoned` | `superseded` | `@verifiedBy` | `@supersededBy` | edits |
|---|---:|---:|---:|---:|---:|
| estate A | 0 | 0 | 0 | 0 | **0** |
| estate B | 3 | 0 | 12 | 0 | 15 |
| estate C | 48 | 12 | 4 | 24 | 88 |

One estate is untouched; ~85% of the total lands on a single ledger.

## Why `@verifiedBy` specifically

It asked you to name a test. `verify` then checked that the **name** occurred somewhere in
your test sources — whole-word, any language, never running anything. So it could prove a name
existed and never that the named test verified the claim attached to it.

Auditing one ledger — 55 entries, 9 carrying `@verifiedBy`, **19 names** — by opening each
named test and reading its assertions found **4 of 19 did not verify their claim**: one matched
a **comment** (its only occurrence in the whole corpus), one a **dependency-injection key** in
test setup, one a **real test of a different claim**, and one a test of the entry's *output*
where the claim was about its *source text*. `verify` reported zero errors throughout.

The scan was not defective — precision-over-recall was deliberate, so a "missing" verdict meant
the name appeared in **no** test file at all. The defect is structural: **the author picks the
string, so the cheapest way to satisfy the check is to find a name that already exists**, and
anything optimising against a gate takes the cheapest satisfying move every time. Comment-only
matches were made to warn, which reaches one of the four; the other three are semantic and no
lexical rule reaches them.

## What replaces the test link

Nothing yet, deliberately. The replacement inverts the direction — a generator emits the test
**from** the requirement, so the link is structural instead of a string somebody chose. That
work is additive and ships separately.

Until then a requirement carries no test link, and **that is a legitimate declared state**:
which requirements get tests, at which levels, in what style, or none at all, is the
application's policy rather than the library's.

`verify` continues to check everything else it checked before: `@status` values, required
attrs, child rules, levels, the L4 link floor, `@implementedBy` resolution with severity
conditional on `@status`, architectural universality, and object coverage.
