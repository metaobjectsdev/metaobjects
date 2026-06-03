---
name: metaobjects-verify
description: Use when verifying MetaObjects: drift checks (verify --db/--codegen/--templates), schema migrations, and interpreting conformance/test failures.
---

# MetaObjects verify + migrations

The third pillar: **drift detection.** MetaObjects treats metadata as the source of
truth and generated code + DB schema + prompts as derived. `verify` is the
cross-cutting discipline that catches divergence; schema migration is the build-time
pipeline that brings the database into line with metadata. This skill is the
procedure for running both and reading the failures.

## The drift sources

Drift is any place where a derived artifact has fallen out of sync with the
metadata that should define it. The ones a developer must actively guard:

- **DB-vs-metadata** — the live database schema has diverged from the metadata
  (a column the metadata no longer declares, a missing index, a type mismatch).
- **Generated-vs-metadata (codegen)** — committed generated code no longer matches
  what the current metadata would emit (someone edited a `@generated` file, or
  forgot to regenerate after changing metadata).
- **Prompt-vs-payload (templates)** — a template references a `{{field}}` that
  isn't on its `@payloadRef` payload VO (a renamed source field silently degrading
  a prompt).

Two more are caught structurally rather than by a command: **generated-edited**
(the `@generated` header + three-way merge surface hand-edits at code review) and
**migration-vs-metadata** (migrations are emitted *from* metadata diffs, so they
can't drift by construction).

## The `verify` subverbs

`verify` has three drift checks. Run them in CI.

- **`--db`** — schema drift. Introspects the live database and fails if it has
  diverged from metadata. This is a **schema concern, so it is the Node toolchain's
  job regardless of your server language** (see migrations below). On the JVM ports
  a runtime startup validator catches generated-table drift at app boot as a
  complementary check, but the authoritative DB-vs-metadata gate is the Node
  `verify --db`.

- **`--codegen`** — regeneration drift. Re-runs generation and diffs the result
  against the committed generated files; a non-empty diff means someone edited
  generated code or skipped a regen. Wire it into CI so a stale `@generated` file
  fails the build.

- **`--templates`** — prompt/payload drift. For every `template.prompt` /
  `template.output`, resolves the text, parses each `{{...}}` reference, and fails
  if any reference isn't on the payload VO. This is the build-time gate for the
  prompt-construction pillar.

A clean run is silent; a failure names the entity/template, the drifted artifact,
and (for templates) the missing reference. **Bias toward trusting the tool** — a
verify failure almost always means the metadata changed and a derived artifact
didn't follow.

## Schema migrations are the shared TypeScript engine — for every port

This is the load-bearing architectural fact (ADR-0015): **schema migrations are
owned by one shared TypeScript engine, regardless of your server language.** The
Node `meta migrate` and `meta verify --db` are the migration + live-DB-drift
toolchain for TS, Java, Kotlin, C#, and Python alike.

What this means in practice:

- The Node `meta` CLI emits the migration SQL (diffing metadata → DDL) and applies
  it. You point it at the same database your server connects to:

  ```
  meta migrate --db postgresql://... --slug initial   # emit migration SQL
  meta migrate --db postgresql://... --apply          # apply pending migrations
  meta migrate --dry-run                              # preview without writing
  ```

- Dialects: `postgres` (default), `sqlite`, and `d1` (Cloudflare D1, TS-only).
- The JVM and Python ports have **no** migration command of their own — their
  former migrate goals/modules were removed. A JVM service may auto-create
  dev/test tables at startup for convenience, but production schema is always the
  Node migrate engine's output.

So even in a Java or Python or C# project, schema migration and `verify --db` run
through the Node `meta` tool. The per-port `gen`/codegen tooling stays native to
the language; only schema crosses to Node.

## Interpreting conformance / test failures

MetaObjects' behavior is pinned by cross-port **conformance corpora** (metamodel,
render, persistence, API-contract, verify). When a test or conformance fixture
fails:

- A **loader** failure cites an `ERR_*` code (e.g. `ERR_RESERVED_ATTR`,
  `ERR_UNKNOWN_EXTENDS`, `ERR_MISSING_REQUIRED_ATTR`, `ERR_BAD_ATTR_VALUE`,
  `ERR_YAML_COERCION`) — fix the metadata, not the loader.
- A **render/verify** failure means the rendered bytes or the template-drift
  result diverged from the pinned expectation — usually a payload/text mismatch.
- A **persistence / API-contract** failure means a query result row or an HTTP
  response shape diverged from the cross-port expectation — treat a deviation as a
  bug in the code under test, not in the corpus.

The corpus is the contract: when output disagrees with a fixture, the output is
what's wrong.

---

For the migration tooling read `references/migration.md`.
