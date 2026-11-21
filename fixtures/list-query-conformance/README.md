# `list-query-conformance/` — how a list route reads its query string

The shared parse cases of the REST standard's list handling. Each case is a query string in, and
out comes either the parsed list query (filter tree, search, sort, page) or the 400 body the route
refuses with. They run with no web server and no database: what they pin is the parse, which a
port's list route does before its query library sees anything. What a parsed query then
*matches* in a store is the api-contract corpus's job (`fixtures/api-contract-conformance/`).

## Files

- `meta.json` — one `Ticket` entity with a field of every filterable kind: text, string- and
  int-backed enums, int, double, decimal, currency, boolean, date, time, an instant timestamp, a
  `@localTime` timestamp, uuid and duration. It also has one field that is not `@filterable`
  (`notes`), one with `@sortable: false` (`score`) and one with `@sortableDefaultOrder: desc`
  (`priority`).
- `cases.json` — `cases[]`, each `{ group, name, query, why, expect }`. `query` is the raw query
  string as it arrives, percent-encoding included. `expect` is one of:
  - `{ "list": { filter?, search?, sort?, limit?, offset? } }` — the parsed query, with members
    that are absent left out;
  - `{ "error": { "error": "<wire code>", ... } }` — the exact 400 body.

The allowlist is not written in the fixture. A runner derives it from `meta.json` the way its
port's generator does (the generated `<Entity>FilterAllowlist` / `SortAllowlist`), so a port whose
generator derives a different allowlist fails here.

## The parsed form

- A **leaf** is `{ field, op, value }`. Two or more conditions are `{ "and": [...] }` in the order
  they were sent, and `filter[or][i]` is `{ "or": [...] }` in index order. An `or`/`and` with one
  branch is that branch.
- **Values are neutral**, not a driver's:
  - a number (int, long, double, currency) is a JSON number, and on an integer field a fraction
    is refused;
  - a boolean (`true`/`1`/`false`/`0`) is a JSON boolean, and so is `isNull`'s operand;
  - a decimal is its canonical text (`10.50` → `"10.5"`, `1.5e2` → `"150"`), never a double;
  - an instant timestamp is a UTC ISO string (a bare date is midnight UTC, no zone is UTC, an
    offset is converted);
  - a `@localTime` timestamp is kept as sent unless it carries a zone, which is converted to UTC;
  - `in` is a list split on commas, each element trimmed and typed like a scalar;
  - everything else (text, enum member, date, time, uuid, duration, a `like` pattern) is the
    string as sent, once it passes the format check.
- `search` is `{ term, fields }`. `fields` lists the filterable fields whose band includes
  `like`: plain text and string-backed enums, but not a uuid or an int-backed enum, because a
  case-insensitive substring match on those columns is an error on Postgres. An empty `search`
  is no search.
- `sort` is `{ field, order }`. A missing order takes the field's `@sortableDefaultOrder`, or
  `asc` if it has none.

## Refusals and their order

The wire codes are the REST standard's ([`docs/features/api-contract.md`](../../docs/features/api-contract.md)):
`invalid_filter_field`, `invalid_filter_op`, `invalid_filter_value`, `invalid_sort`,
`filter.bare_field`, `filter.nesting_too_deep`, `filter.in_too_large`,
`filter.leading_wildcard_disallowed`, `pagination.invalid_value`. When a query has more than
one fault, the first one found is reported, and they are found in this order:

1. bare field parameters;
2. `limit`, then `offset`;
3. the filter, depth-first, in the order its keys were sent;
4. the sort;
5. the search.

The `fault-order` group pins that order.

Caps: five levels of `or`/`and` nesting (the sixth is `filter.nesting_too_deep`, `limit: 5`) and
100 `in` elements (`filter.in_too_large`, `limit: 100`). A query-string parser has to be able to
reach the nesting cap: `qs`'s default depth of 5 cannot (the sixth bracket pair stays part of the
key), so the TypeScript mounts parse with a depth sized to the cap.

## Runners

- TypeScript (the source of the expected answers):
  `server/typescript/packages/integration-tests/test/list-query-conformance.test.ts`.
  To regenerate after an intended change, run
  `UPDATE_LIST_QUERY_FIXTURES=1 bun test test/list-query-conformance.test.ts`, then review every
  changed answer, because the answers are the cross-port contract.
