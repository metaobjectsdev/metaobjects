---
name: cross-language-porting
description: Use when porting a metaobjects feature or implementation to another language (Java/Python/C#) — keeps the port aligned to the conformance corpus without forcing un-idiomatic code
---

# Cross-Language Porting

Port a metaobjects feature or implementation to another language while staying
conformance-aligned. The conformance corpus is the oracle; you are the
translator, never the alignment authority.

## The Tier taxonomy — what you may change

- **Tier 1 — Invariant.** Metamodel vocabulary, canonical wire format, the
  provider contract, observable semantics, error codes. Never change these.
- **Tier 2 — Idiomatic.** API naming, null representation, collection types,
  sync/async, error-handling style, provider discovery. Make these native to
  the target language.
- **Tier 3 — Free.** Internal mechanism, file layout, performance.

## Workflow

1. **Fixtures first.** Confirm the TS reference behavior has conformance
   fixtures. If not, write them (and confirm the TS run is green) before
   porting. A metamodel feature is not done until its fixtures exist.
2. **Port idiomatically.** Change Tier 2/3 freely; never Tier 1. Write the
   port's `ConformanceAdapter` — binding, navigator, error-code map.
3. **Run the conformance runner.** The corpus is the oracle — but when a
   fixture goes red, ask "should it match?" before "how do I make it match."
   It may be a stale or wrong golden, not a port bug.
4. **Update the expected-failures ledger.** Record honestly what is not done.
   Never silently regenerate a golden to turn a check green.
5. **You are the translator, not the authority.** Pass/fail is the corpus's
   call. Escalate a suspected wrong fixture; do not edit it to match the port.
