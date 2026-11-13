# `api-contract-conformance/api-settings/` — the project's `api` block on generated routes

Cross-port REST contract for the `api` block of `.metaobjects/config.json`: `api.pagination`,
which gives every generated list route a default page size and a hard cap on `?limit=`, and
`api.unknownFields`, which decides what a generated create, PUT or PATCH route does with a body
key the entity does not declare. The settings live in this sub-corpus's own
`.metaobjects/config.json`, not in a runner:

```json
{ "api": { "pagination": { "defaultLimit": 2, "maxLimit": 4 }, "unknownFields": "drop" } }
```

so a lane reaches them exactly the way an adopter's project does, through the config the
metadata load reads. The rest of that file repeats the parent corpus's `naming` and `wire`.

The model is one `Item` (`id`, `title`), seeded with five rows. The sizes are small so the
scenarios can tell the default page from the whole table and the cap from the table size.

## The contract

`api.pagination`:

- **No `limit` answers the default page.** `GET /api/items` returns 2 rows, not 5.
- **The cap is inclusive.** `?limit=4` returns 4 rows.
- **Over the cap is refused, not clamped.** `?limit=5` answers
  `400 {"error": "limit_too_large", "maxLimit": 4}`, so a client that asked for more than the
  server serves is told so instead of receiving a short page it cannot tell from the end.
- **Paging past the default works.** `?offset=4` returns the one remaining row, and
  `?withCount=1` answers 2 rows with `total: 5`.

A project WITHOUT `api.pagination` keeps the behaviour the parent corpus pins: no default page
and no cap. That half is the other sub-corpora, none of which sets it.

`api.unknownFields: drop`:

- **An undeclared key is ignored.** A create, PATCH or PUT carrying `isAdmin` is answered
  201/200 with the declared fields written, and `isAdmin` is neither stored nor echoed.

The default, `reject`, is pinned by the parent corpus, which sets nothing:
`scenarios/input-unknown-fields-rejected.yaml` and `tph/scenarios/tph-unknown-fields-rejected.yaml`.

## Lanes

Generated lane only, as for every sub-corpus whose subject is what a generator emits. Every
port runs it: TypeScript, C#, Java, Kotlin and Python.

## Files

```
api-settings/
├── README.md
├── .metaobjects/config.json    # api.pagination { 2, 4 }, api.unknownFields "drop"
├── meta.json                   # Item
├── seed.json                   # five rows
└── scenarios/
    ├── default-page-size.yaml
    ├── limit-at-max.yaml
    ├── limit-over-max.yaml
    ├── offset-pages-past-default.yaml
    ├── unknown-fields-dropped.yaml
    └── with-count-default-page.yaml
```
