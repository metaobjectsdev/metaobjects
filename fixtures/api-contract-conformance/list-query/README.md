# `api-contract-conformance/list-query/` — the REST standard's list handling, against a store

What a list query matches in a real store, and how a generated route refuses a bad request.
The parse itself (query string in, filter tree or named 400 out) is pinned with no server and
no database by [`fixtures/list-query-conformance/`](../../list-query-conformance/). This
sub-corpus checks that what was parsed reaches the store with the intended meaning.

The model is one `Part` (`id`, `name`, `sku` with a unique key, `category` enum, `stock`, and a
`notes` field that is not filterable). The seed holds 60 rows, more than 50, so that a page
boundary sits inside the table. Four names differ only in case and position, so search and
`like` can be told apart: `Pump Housing` (7), `pump seal` (8), `Bilge PUMP` (9) and
`Sump Pump` (10).

## The contract

- **`?search=` ignores case; `like` does not** (ADR-0049). `search=pump` finds 7, 8, 9 and 10.
  `filter[name][like]=Pump%` finds only 7, and `pump%` only 8. Search covers every filterable
  text field, so `sku-05` finds rows 50 to 59 by their sku. Search and filter are both applied,
  and `withCount=1` counts what they match.
- **`filter[or]` / `filter[and]`** combine, and an `or` beside a plain condition is ANDed with
  it. Five levels of nesting are served, and the sixth is `filter.nesting_too_deep`.
- **Refusals name what was wrong:**
  - a bare `?name=` is `filter.bare_field`, and so is `?notes=` on a field that is not
    filterable;
  - a leading `%` is `filter.leading_wildcard_disallowed`;
  - a value of the wrong type is `invalid_filter_value`;
  - a page bound that is not a non-negative integer is `pagination.invalid_value`.

  An unknown parameter such as a cache-buster is ignored.
- **The default page is 50:** with no `limit` (the corpus sets no `api.pagination`), a list
  answers rows 1 to 50, `offset=50` answers 51 to 60, `limit=60` answers all 60 (no maximum
  without the setting), and `withCount=1` answers 50 rows with `total: 60`.
- **Paging past 50:**
  - `limit=51` answers 51 rows;
  - `limit=5&offset=51` answers rows 52 to 56;
  - `limit=0&withCount=1` answers no rows with `total: 60`.
- **Bad bodies, bad ids and failed writes:**
  - a body that is not JSON is `400 {"error": "invalid_json"}`;
  - a path id the key cannot hold is `400 {"error": "invalid_id"}` on GET, PATCH and DELETE;
  - a create that breaks the unique `sku` is `409 {"error": "constraint_violation", "constraint": "unique"}`.

`rawBody` on a request is sent byte-for-byte as `application/json`, which is how a scenario
sends a body that is not JSON.

## Lanes

Generated lane only, like `write-through/` and `report/`. What is under test is whether a
port's generated list route honours the REST standard; a hand-rolled reference server would
answer every scenario by construction.

Runners: TypeScript `server/typescript/packages/integration-tests/test/api-contract-list-query.test.ts`
(one Postgres container for the file, reseeded before every scenario). The other ports'
runners arrive with their 1.3.0 REST-standard work.
