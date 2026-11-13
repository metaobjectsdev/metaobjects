# `api-contract-conformance/pagination/` — a project page size on generated list routes

Cross-port REST contract for `api.pagination`, the project setting that gives every generated
list route a default page size and a hard cap on `?limit=`. The setting lives in this
sub-corpus's own `.metaobjects/config.json`, not in a runner:

```json
{ "api": { "pagination": { "defaultLimit": 2, "maxLimit": 4 } } }
```

so a lane reaches it exactly the way an adopter's project does, through the config the
metadata load reads. The rest of that file repeats the parent corpus's `naming` and `wire`.

The model is one `Item` (`id`, `title`), seeded with five rows. The sizes are small so the
scenarios can tell the default page from the whole table and the cap from the table size.

## The contract

- **No `limit` answers the default page.** `GET /api/items` returns 2 rows, not 5.
- **The cap is inclusive.** `?limit=4` returns 4 rows.
- **Over the cap is refused, not clamped.** `?limit=5` answers
  `400 {"error": "limit_too_large", "maxLimit": 4}`, so a client that asked for more than the
  server serves is told so instead of receiving a short page it cannot tell from the end.
- **Paging past the default works.** `?offset=4` returns the one remaining row, and
  `?withCount=1` answers 2 rows with `total: 5`.

A project WITHOUT the setting keeps the behaviour the parent corpus pins: no default page and
no cap. That half is the other sub-corpora, none of which sets `api.pagination`.

## Lanes

Generated lane only, as for every sub-corpus whose subject is what a generator emits.
**TypeScript runs it today.** The C#, Java, Kotlin and Python routes do not read
`api.pagination` yet: their REST generators are under the 2026-09-22 freeze, and adding the
setting there waits on that ruling.

## Files

```
pagination/
├── README.md
├── .metaobjects/config.json    # api.pagination { defaultLimit: 2, maxLimit: 4 }
├── meta.json                   # Item
├── seed.json                   # five rows
└── scenarios/
    ├── default-page-size.yaml
    ├── limit-at-max.yaml
    ├── limit-over-max.yaml
    ├── offset-pages-past-default.yaml
    └── with-count-default-page.yaml
```
