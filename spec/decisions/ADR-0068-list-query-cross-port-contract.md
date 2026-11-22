# ADR-0068: The list query is part of the cross-port REST contract

## Status

**Accepted** (2026-11-21), for 1.3.0. Registers no vocabulary: `metamodelVersion` is unchanged. It
changes what the REST standard promises about a list route, in every port.

## Context

The REST standard's list handling was TypeScript-only in several places. `?search`,
`filter[or]` / `filter[and]`, the nesting cap, the bare-field and leading-`%` refusals, the
filter-value format check and the `in` list cap existed in the TypeScript runtime and nowhere
else. The `invalid_json`, `invalid_id`, `pagination.invalid_value` and `constraint_violation`
responses were the same. `docs/features/api-contract.md` said these were deferred until a consumer
asked, and told adopters not to assume them on a non-TypeScript backend.

A client that is generated once and runs against any backend needs one answer to one query
string. Where ports differ, the difference reaches the adopter as a silently different result
set or a 5xx instead of a named 400. The ports also have no shared test of how a list route reads
its query string, so a port could not be held to the TypeScript behaviour.

## Decision

1. These are part of the REST contract, with TypeScript's wire names unchanged:
   - `?search`, a case-insensitive substring match across the entity's `@filterable` text fields;
   - `filter[or]` and `filter[and]`, and the nesting cap of five levels;
   - the refusal of a bare field parameter and of a `like` pattern that starts with `%`;
   - the filter-value format check, and the cap on the length of an `in` list;
   - the `invalid_json`, `invalid_id`, `pagination.invalid_value` and `constraint_violation`
     responses.
2. Two shared corpora are the authority, not the prose:
   - `fixtures/list-query-conformance/`: a query string in, and a filter tree or the exact 400
     body out, with no server and no database;
   - the `list-query/` sub-corpus of `fixtures/api-contract-conformance/`: what a parsed query
     matches in a real store, over HTTP, in the generated lane.
3. A name every object inherits (`constructor`, `toString`, `__proto__`) is not an allowlisted
   field. A port looks fields up as own keys only, so such a name is `invalid_sort` or an unknown
   filter field, like any other name that is not declared.
4. Each port passes both corpora before the 1.3.0 release candidate `rc.4`. Until a port's
   runner is in, `docs/CONFORMANCE.md` records that port as pending. Each port's change flips its
   own entry; the prose in `docs/features/api-contract.md` is true of a port once its entry reads
   as passing.

## Consequences

- An adopter can rely on one list-query behaviour on any backend once that backend's entry reads
  as passing.
- A port that diverges fails a shared corpus. It no longer diverges unnoticed.
- The TypeScript behaviour becomes a compatibility constraint: changing a wire name or a refusal
  needs a new corpus case and an amendment to this ADR.
- At the time of writing only TypeScript passes both corpora. C#, Java, Kotlin, Python and Rust
  are pending their 1.3.0 REST-standard work.
