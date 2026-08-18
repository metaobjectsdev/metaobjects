# scope-conformance

Pins the pattern semantics of a consumer's `include`/`exclude` **scope** — the
filter over fully-qualified node names (`pkg::Sub::Name`) that decides which
metadata a source is authoritative for (phase 1 of metadata-source
resolution). `*` and `**` are easy to reinvent slightly differently per port;
this is the same failure mode that produced the cross-port `LIKE`/`ILIKE`
divergence fixed in 0.21.6. Every port's runner reads the single committed
`cases.json` — there is no per-port fixture and no ledger.

## Shape

```
cases.json   # { cases: [{ name, scope: {include?, exclude?}, expect: [{fqn, matches}] }] }
README.md
```

## Semantics

- **Separator** is `::` (the package separator). A fully-qualified name is a
  `::`-joined sequence of one or more segments.
- **`*`** inside a segment matches any run of characters, but **never crosses
  a `::`** — it is scoped to a single segment. `acme::Order*` matches
  `acme::OrderLine` but not `acme::deep::OrderLine`.
- **A segment that is exactly `**`** matches **one or more** whole segments.
  `acme::**` matches `acme::Order` and `acme::a::b::Secret` but not the bare
  `acme` (zero segments) — `**` never matches "nothing". `**` may also appear
  mid-pattern (`acme::**::Order`), where it still requires at least one
  segment between the fixed literals — `acme::Order` does **not** match
  `acme::**::Order` (see `double-star-in-the-middle`).
- All other pattern characters (including regex metacharacters like `.`) are
  **literal** — a pattern is never a general regex.
- **`include`** absent or empty means "everything is included". Otherwise a
  name matches if **any** `include` pattern matches it (union).
- **`exclude`** is applied **after** `include` — a name excluded is excluded
  regardless of which `include` pattern admitted it. `exclude` with no
  `include` narrows the "everything" default.
- **Matching is case-sensitive** — a pattern and a name must agree in case
  (`acme::Order` does not match `acme::order` or `ACME::Order`).

## Behavioral contract

Each port's runner reads `cases.json`, and for every case: compiles `scope`
with its native pattern compiler, then for every `expect` entry asserts
`isInScope(fqn, compiledScope) === matches`. All ports assert the same
booleans — single-source, byte-identical expectations.

## Reference implementation

`server/typescript/packages/sdk/src/scope.ts` (`compileScope` / `matchesScope`
/ `compilePattern`) is the TypeScript reference this corpus was authored
against; other ports are free to implement the same semantics however is
idiomatic (e.g. a native regex engine, or a hand-rolled segment matcher) as
long as every case in this file passes.
