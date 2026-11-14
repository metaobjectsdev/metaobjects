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
- **`limit=0` is an empty page.** `?limit=0` answers no rows: an explicit zero is a page size,
  not "no limit", so it is neither the default page nor the whole table.
- **A negative limit is refused.** `?limit=-1` answers `400 {"error": "pagination.invalid_value",
  "param": "limit", "value": "-1", "expected": "a non-negative integer (0 or more)"}` rather than
  reaching the store, where SQLite reads `LIMIT -1` as no limit at all.
- **Paging past the default works.** `?offset=4` returns the one remaining row, and
  `?withCount=1` answers 2 rows with `total: 5`.

A project WITHOUT `api.pagination` keeps the behaviour the parent corpus pins: no default page
and no cap. That half is the other sub-corpora, none of which sets it.

`api.unknownFields: drop`:

- **An undeclared key is ignored.** A create, PATCH or PUT carrying `isAdmin` is answered
  201/200 with the declared fields written, and `isAdmin` is neither stored nor echoed.

The default, `reject`, is pinned by the parent corpus, which sets nothing:
`scenarios/input-unknown-fields-rejected.yaml` and `tph/scenarios/tph-unknown-fields-rejected.yaml`.

## The shared config cases

`config-blocks.json` is a second, smaller contract: what each port's CONFIG READER accepts in
the `api` block, before any route runs. Each `cases[]` entry is an `api` block (`null` means the
key is absent) and the `pagination` and `unknownFields` it must resolve to; each `invalid[]`
entry must be refused when `.metaobjects/config.json` is read. A page size is a positive whole
number however JSON spells it (`50` and `50.0` are the same number, since JavaScript cannot tell
them apart), at most 2147483647 so every port's integer type holds it. The message wording is
each port's own. Runners: TypeScript `sdk/test/api-config-conformance.test.ts`, C#
`ApiConfigConformanceTests`, Java `ApiConfigConformanceTest` (Kotlin reads config through the
Java reader), Python `tests/conformance/test_api_config_conformance.py`.

## Lanes

Generated lane only, as for every sub-corpus whose subject is what a generator emits. Every
port runs it: TypeScript, C#, Java, Kotlin and Python.

## Files

```
api-settings/
├── README.md
├── config-blocks.json          # shared config-reader cases (not a scenario)
├── .metaobjects/config.json    # api.pagination { 2, 4 }, api.unknownFields "drop"
├── meta.json                   # Item
├── seed.json                   # five rows
└── scenarios/
    ├── default-page-size.yaml
    ├── limit-at-max.yaml
    ├── limit-negative.yaml
    ├── limit-over-max.yaml
    ├── limit-zero.yaml
    ├── offset-pages-past-default.yaml
    ├── unknown-fields-dropped.yaml
    └── with-count-default-page.yaml
```
