# Sophisticated metadata validation — architecture options & recommendation

_2026-06-19. Triggered by the cross-reference gap: a dangling `relationship.@objectRef`
or `identity.reference.@references` loaded silently instead of failing. The narrow fix is
easy; the real question is **how metadata validation should be architected** so that
sophisticated checks — especially cross-references — are correct, extensible, and
consistent across the five ports._

## The problem, framed correctly

Loading metadata is a **compiler front-end**, not a schema check:

```
parse (per file)  →  merge/overlay  →  [ build symbol table  →  resolve refs  →  semantic checks ]  →  freeze
                                        └──────────────── "semantic analysis" ─────────────────┘
```

Two classes of validation, with very different needs:

1. **Local / structural** — decidable from a single node: required attrs, enum membership,
   `@kind` values, value coercion, child placement. JSON-Schema / XSD-class checks.
2. **Global / relational** — decidable only against the *whole loaded tree*: `@objectRef`,
   `identity.reference.@references`, `extends`, `template.@payloadRef`, `origin
   @from/@of/@via`. These are **name-resolution** problems — a node alone cannot answer
   them; you need an index of every object/field first.

The gap we hit (`@objectRef` to a non-existent entity loading clean) is a *global* check
that was simply never written. The interesting question is the architecture that makes the
whole **global** class systematic instead of hand-coded one attr at a time.

## What the field does (research)

- **TypeScript compiler** (most relevant — we're TS-first): a strict two-phase split. The
  **binder** walks the tree once and builds a **symbol table**; the **checker** then
  consumes that table to resolve names and report errors. Cross-file merging is handled by
  a **merged-symbols table** — the direct analogue of our overlay/merge across `meta.*`
  files. Logic lives in the binder/checker, **not** on the AST nodes.
  ([binder notes](https://github.com/microsoft/TypeScript-Compiler-Notes/blob/main/codebase/src/compiler/binder.md), [TS Deep Dive: Binder](https://basarat.gitbook.io/typescript/overview/binder))
- **GraphQL** validation is a **visitor** running a **set of rules** over the AST.
  ([Life of a GraphQL Query — Validation](https://medium.com/@cjoudrey/life-of-a-graphql-query-validation-18a8fb52f189))
- **Crystal compiler** runs the AST through **multiple visitor passes**, one per concern
  (classes, vars, types…). ([Visiting an AST](https://patshaughnessy.net/2022/1/22/visiting-an-abstract-syntax-tree))
- **Smithy** (AWS — a model standard we benchmark against): validation is a registry of
  **validators** that match shapes with **selectors** (a DSL) and emit **validation events**
  with configurable **severity** + source location. Custom validators are **declarative —
  no code**. ([Smithy model validation](https://smithy.io/2.0/spec/model-validation.html), [Selectors](https://smithy.io/2.0/spec/selectors.html))
- **XSD** has `key`/`keyref` for *limited declarative* referential integrity; **JSON
  Schema is explicitly context-free** and does **not** do cross-references (referential
  integrity is "out of scope — application logic"). Cross-element checks need
  **Schematron / SHACL**. ([JSON Schema scope](https://github.com/json-schema-org/json-schema-spec/wiki/Scope-of-JSON-Schema-Validation))
- **SHACL** (W3C): fully **declarative** shapes, rules separated from execution;
  **parameterised constraint components** are where "a validation checklist crosses into a
  type system." ([SHACL overview](https://medium.com/fluree/what-is-shacl-with-examples-2697f659d465), [parameterised constraints](https://ontologist.substack.com/p/shacls-hidden-superpower-parameterised))

**Three convergent lessons:** (1) build a **symbol table** before resolving references;
(2) run checks as **visitor/rule passes**, not as methods on the nodes; (3) the most
sophisticated systems make cross-references **declarative + data-driven**, so new
reference kinds validate for free.

## Where we are today

The loaders already run a **multi-pass visitor over the tree** (`validation-passes.ts`,
`ValidationPhase.java`, `validation_passes.py`, `ValidationPasses.cs`) and Python even has
a `_build_object_index` — a primitive **symbol table**. We are *already on the
best-practice path*; it's just **ad-hoc**: the symbol table is rebuilt per pass, each
ref-kind (`extends`, `@payloadRef`, origin paths) is hand-resolved separately, and
`@objectRef`/`@references` were simply missed. There is **no node-level `validate()`** for
metadata structure in any port, and that's consistent with the research.

## Options

### Option A — Node-self-validation: `validate()` on each typed node

`MetaRoot.validate()` recurses; `MetaRelationship` / `ReferenceIdentity` override to check
their own refs.

- **Pros:** ergonomic entry point (`root.validate()`); idiomatic OO; natural in Java where
  nodes are typed subclasses.
- **Cons:** **the research's anti-pattern.** (1) Cross-references need the *global* symbol
  table — a node validating itself either rebuilds the index (O(n²)) or reaches back to
  root, breaking encapsulation anyway. (2) **Doesn't port:** TS/Python have a *single
  generic `MetaData`* — there's no `MetaRelationship` subclass to override, so they'd
  `switch(type)` inside `validate()` = the procedural pass relocated onto a method, but now
  scattered. (3) Adding a new cross-cutting rule means editing N node classes. (4) Couples
  validation lifecycle to construction. Verdict: **the appealing API, the wrong internals.**

### Option B — Keep ad-hoc procedural passes (status quo + the two missing checks)

Just add `@objectRef`/`@references` resolution as two more hand-written passes (what the
in-flight TS/Java change does).

- **Pros:** minimal; already green in TS/Java; ports cleanly.
- **Cons:** doesn't address "**more sophisticated**." The symbol table stays implicit and
  rebuilt; every future ref-kind is another bespoke pass; no severity model beyond
  error/warn; drift risk between the 5 hand-written copies per pass.

### Option C — Formalized semantic phase: symbol table + rule registry + **declarative reference model** (recommended)

Make explicit what the field does:

1. **One symbol table** built once per load (object index by name/fqn/resolutionKey — Python
   already has the seed), shared by every resolving pass. The merged/overlay step is our
   "merged-symbols table."
2. A **validation-rule registry** — each rule is a small visitor (`(root, symbols, emit)
   → void`). The existing passes *become* registered rules; new rules register without
   touching the loader or the nodes. Mirrors Smithy validators / GraphQL rule sets.
3. **Declarative reference descriptors.** Today `REF_BEARING_ATTR_NAMES` already lists the
   ref-bearing attrs. Promote that to a typed registry: each ref attr declares *what it
   points at* (`objectRef → object`, `references → object(+fields)`, `payloadRef →
   object.value`, `extends → same-type node`, origin paths → field/relationship paths). **A
   single generic resolver** then validates **every** cross-reference uniformly against the
   symbol table — `@objectRef`/`@references` stop being special-cased and any future ref
   attr is covered for free. This is XSD `keyref` / Smithy selectors / SHACL, adapted.
4. **Severity-tagged diagnostics** (error / warn / info) with source location — we already
   have the error+warning envelope; formalize the levels (Smithy's model).
5. **Ergonomic entry point:** expose `root.validate()` (or `loader.validate()`) as the
   public API **that runs this phase** — so the API the human/agent reaches for is the nice
   one, while the internals are the best-practice registry, **not** logic-in-each-node. This
   reconciles the "`validate()` on `MetaRoot`" instinct with the research.

- **Pros:** matches every mature comparable; cross-references become **data-driven and
  exhaustive** (the actual "sophisticated validation" ask); extensible without touching
  nodes or the loader; **ports identically** to OO and generic-node ports (rules are
  functions, not methods); one symbol table, no O(n²); conformance gates the rule set.
- **Cons:** more upfront design than Option B; the declarative ref registry is a new
  (small) cross-port contract to keep in lockstep.

### Option D — Full declarative constraint language (SHACL/Schematron-style) for all rules

Express *every* rule (structural + relational) as data.

- **Pros:** ultimate extensibility; non-code authoring of org-specific rules (an enterprise
  ask).
- **Cons:** large; a second mini-language to design, port, and conformance-gate; most local
  checks are clearer as code. **Premature** — but Option C's reference descriptors are a
  deliberate first step *toward* this if demand appears.

## Recommendation

**Adopt Option C, incrementally — and treat Option A's `root.validate()` purely as the
public entry point over C's internals, never as logic-on-nodes.**

Concrete phasing:

- **Phase 1 (now): land the two missing checks as registered rules.** The in-flight
  `@objectRef` / `@references` enforcement (TS + Java done, green; Python + C# to match)
  ships as-is — it's already the visitor/pass shape Option C formalizes, and it closes the
  correctness gap the user hit. New codes `ERR_INVALID_REFERENCE` (+ `@objectRef` folded
  into `ERR_INVALID_RELATIONSHIP`), gated by `error-relationship-unresolved-objectref` and
  `error-identity-reference-unresolved` fixtures in all five ports.
- **Phase 2: extract the symbol table + rule registry.** Refactor the existing passes into
  a registered list sharing one built-once object index. Behavior-preserving; conformance
  is the safety net. Add `root.validate()` / `loader.validate()` as the entry point.
- **Phase 3: declarative reference descriptors.** Replace the five hand-coded resolvers
  (`extends`, `objectRef`, `references`, `payloadRef`, origins) with one generic
  reference-resolution rule driven by per-attr ref descriptors. This is the leap to
  "sophisticated, especially object ref" — and where a renamed/removed target is caught
  uniformly, by construction, for every reference kind present and future.
- **Phase 4 (optional, demand-driven): formalize diagnostic severities** and consider a
  thin declarative-rule surface (Option D) only if enterprise "custom org rules" demand it.

Cross-port note: Java/Kotlin may *additionally* expose the idiomatic `root.validate()`
instance method (it's natural with typed nodes), but its body calls the shared semantic
phase — it does **not** re-implement checks per node class. TS/Python/C# expose the same
entry point as a function over the generic node. Same behavior, conformance-locked.

## Immediate decision needed

Phase 1 is independent and already mostly done. Phases 2–3 are the "sophisticated
validation" investment. Recommend: **merge Phase 1 now** (close the gap), then schedule
Phase 2–3 as a focused follow-up (one FR, cross-port, conformance-gated) rather than
blocking the bug fix on the refactor.
