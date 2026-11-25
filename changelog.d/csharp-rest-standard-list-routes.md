- **C#: the generated list routes speak the REST standard.** Every entity, projection, report and
  single-table-hierarchy list route now reads its query through `ListQueryParser`: `?search=`
  (case-insensitive, over the filterable text fields), `filter[or][i]` / `filter[and][i]` groups
  five levels deep, and the named refusals `filter.bare_field` (a `?name=` outside `filter[...]`,
  which used to answer every row), `filter.leading_wildcard_disallowed`, `filter.nesting_too_deep`
  and `invalid_filter_value` for a value of the wrong format. A refusal's body carries the shared
  details (`field`, `expected`, `allowed`), so an `invalid_sort` lists the sortable fields. A body
  that is not JSON is now `400 {"error": "invalid_json"}` (it was the `validation` body), and a
  path id the key cannot hold is `400 {"error": "invalid_id"}` on every item route (it was an
  empty 400 from ASP.NET Core's binding). The sortable set is unchanged. The routes read the new
  `RouteErrors` helper in `MetaObjects.AspNetCore`, and `dotnet meta eject routes` copies it with
  the others. The filter allowlist now carries the parser's rule table (`Rules`, `Sort`,
  `FieldNames`), typed with the helpers, so `routes` and `filter-allowlist` are ejected together:
  naming either owns both, and `eject --undo` gives both back. The C# generated lane now runs the whole `list-query/` sub-corpus, closing the C#
  routes' `KNOWN_GAPS.md` G2. Generated-output change — regenerate to pick it up; three-way merge
  preserves hand edits.

  Upgrading: a project that owns `routes` and not `filter-allowlist` runs
  `dotnet meta eject filter-allowlist` (or `eject routes --force`), so both read the owned helpers.
  A client that sent a bare `?field=value` and read every row back now gets a 400;
  send `filter[field][eq]=value`. A client that matched the `validation` body of a malformed JSON
  request should match `invalid_json`.
