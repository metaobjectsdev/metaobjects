# Tenets-materializing + oversell review — candid self-assessment

**Date:** 2026-07-12
**Scope:** Two questions. (Q1) Are the core tenets — durable metadata spine, disposable
generated code, four equal pillars — actually materializing where the tool is used, not
just present in the repo? (Q2) Does the outward messaging (metaobjects.dev homepage,
videos, README, llms.txt/llms-full.txt) outrun the delivered reality?
**Method:** Shipped state read from `CLAUDE.md` / `spec/roadmap.md` / `docs/CONFORMANCE.md` /
the conformance corpora and generator sources; outward claims fetched live from
metaobjects.dev and videos.html; field evidence from a blinded Phase-0 retro-test — a
fit-assessment of a real pre-adoption JVM application (referred to here as **the Phase-0
target**), produced with no knowledge of the actual migration, then scored against the
adopter's real migrated metadata spine and human migration plan.
**Stance:** skeptical-advisor. Where a pillar is thinner than billed, it says so.

---

## Part 1 — Are the tenets materializing?

### The core tenet: durable spine, disposable artifact — **MATERIALIZING, with field proof**

- The Phase-0 target's actual migration produced a 117-file metadata spine (94
  `object.entity`, 20 `object.projection`, 15 `object.value`, 62 `field.enum`, 319
  `index.lookup`, 42 `origin.passthrough`) driving a generated surface several times its
  size — the "one declaration, many artifacts" leverage is real, in the healthy multi-×
  band the blinded assessment predicted (~4-5:1, deliberately conservative).
- The durable-spine claim has its strongest single proof in an adopter's JVM port: the
  same metadata spine survived a Java→Kotlin migration with the generated code discarded
  and regenerated — exactly the "spine durable, artifact disposable" thesis.
- The blinded retro-test itself is evidence of a different kind: a high-end LLM given only
  the pre-adoption code + this public repo produced a fit assessment that matched the real
  outcome, and on drift **exceeded** the human expert plan (it found specific,
  git-verifiable production-biting drift the human plan stated only generically). The
  metamodel vocabulary was expressive enough that every major migration move the humans
  made (CHECK→`field.enum`, JSONB bags→typed value objects, read models→projections,
  junction→M:N `@through`) was independently predictable from the public docs.

**Verdict: the promise is real and materializing. But the four pillars are NOT equally
materialized — the honest ranking today is drift > codegen > prompts > runtime.**

### Pillar 1 — Codegen: **MATERIALIZING (the strongest shipped surface)**

Evidence:
- Five ports, each with a native codegen tier, gated by shared corpora — including the
  api-contract corpus's two-lane design (reference server AND the *generated* API booted
  over HTTP), whose generated-lane fan-out found 10 real deployment bugs snapshots missed.
  That is codegen quality being *enforced*, not claimed.
- At the Phase-0 target: the migration retired a duplicate hand-maintained JDBC layer
  (~4.4K LOC) and shadow DTO layers; the blinded assessment's codegen score (4/5) was
  confirmed by the actual outcome.

Thinner than billed:
- **Per-port caps are real** and the README capability matrix (correctly) shows "partial"
  cells — Python codegen for relationships/source-kinds, C# storedProc, etc. The pillar
  headline ("idiomatic code in five languages") is true; the *uniform depth* implication
  is not quite.
- Java codegen generates DTOs / controllers / repository *interfaces* — it does not
  generate your JPA `@Entity` classes. The Phase-0 assessment had to state this explicitly
  ("Hibernate is not replaced"). Any adopter who reads "codegen" as "replaces my ORM
  entity layer" will be surprised. The docs mostly avoid saying that; keep it that way.
- The README capability matrix is **stale in both directions** (see Part 2, row 9) —
  ironically it now *under*-claims shipped codegen (generated Spring/FastAPI controllers,
  Java/Python payload VOs) while other surfaces over-claim. A matrix that's wrong in the
  honest direction still erodes trust.

### Pillar 2 — Runtime metadata: **REAL, BUT THE THINNEST — "equal weight" is aspiration, not field fact**

Evidence it exists: OMDB (Java) is shipped, modernized, Spring-Boot-3-integrated;
`runtime-ts`, Python `ObjectManager`, Kotlin-over-Exposed all run the persistence corpus;
the runtime-web grid demo (video 5) is genuine.

Where it is thinner than billed:
- **The flagship adopter didn't use it.** The Phase-0 target's actual migration kept
  Hibernate as the runtime; the blinded assessment scored runtime 3/5 ("value arrives
  later, opportunistically") and that matched reality. In the one deep field data point we
  have, runtime metadata was *not load-bearing* — codegen and drift carried the adoption.
- **The C# cell is contested by our own docs.** README's matrix says C# runtime metadata =
  "Roadmap", while llms.txt/CLAUDE.md list "EF Core (C#)" under the runtime pillar. EF
  Core executing *generated* code is codegen, not metadata-driven runtime; the README is
  the more honest cell. One of the two surfaces must change (Part 2, row 4).
- The fuller runtime story — metadata API endpoint, browser runtime loader, runtime-driven
  grids/forms against any backend — is **FR-029, scheduled 1.4**. The pillar as marketed
  ("dynamic admin UIs") is today: a React/browser grid + per-port data-access engines.
  Server-rendered UI shops (the Phase-0 target's Thymeleaf admin) get nothing, and the
  assessment correctly listed that as a disqualifier.
- "LLM tool registration" is listed under this pillar on the homepage, README, and
  llms.txt — but MCP exposure is unshipped (roadmap item). Video 5 already dropped this
  claim in its honesty re-render; the text surfaces haven't followed.

**Plain statement: runtime metadata is the fourth pillar by materialization order.
Either say so ("growing"), or pull FR-029 forward. Don't keep billing it equal.**

### Pillar 3 — Drift detection: **MATERIALIZING BEST — the killer app, now field-proven**

This is the pillar where the Phase-0 evidence is close to devastating (in a good way):
- The blinded assessment, from the pre-adoption tree alone, built an 11-row drift ledger
  with **six git/DDL-documented incidents that had already happened** — including a
  production CHECK-constraint violation after an enum grew for 146 migrations without the
  constraint being re-synced, a column width *divergent at assessment time* (annotation
  said 64, live DB said 255, for seven weeks), and a confessed orphan column. All
  verified real. The human migration plan had stated the drift thesis only generically;
  the machine found the specific incidents. `verify --db` / `verify --codegen` /
  `verify --templates` close those exact classes.
- This validates the marketing's center of gravity: the homepage leads with drift, and
  drift is precisely where the field evidence is strongest. The messaging *aim* is right.

Thinner than billed:
- **`verify --db` is Node-CLI-only and Postgres/SQLite/D1-only.** A Java/C#/Python shop
  must add Node to CI to get the strongest gate, and a MySQL/Oracle/SQL-Server/H2 shop
  doesn't get it at all. The Phase-0 assessment had to carry this as a top-3 caveat. The
  docs state ADR-0015 honestly; the *homepage and video 4 do not surface the dialect cap*.
- **Unmodeled surfaces are invisible.** Hand-written views, ad-hoc SQL in scripts, columns
  never modeled — `verify --db` can't flag what the metadata doesn't know (the
  projection/view contract docs now say this; the headline doesn't). The Phase-0 ledger's
  "Python reporting script rotted silently" row is only *partially* closed by adoption.
- "Compile-time error" is headline compression: most of the gate is **build/CI-time**
  (`verify` exit codes), and type-checker breakage covers only typed-surface renames.
  Acceptable compression — but "drift is structurally impossible" (homepage) crosses the
  line. See Part 2, row 1.

### Pillar 4 — Prompt construction: **library-side REAL and conformance-gated; end-to-end value is adopter labor**

Evidence:
- Render + payload-VO + `verify --templates` + FR-006 parser-on-receipt + FR-010/011/012
  output-format fragment + tolerant extract genuinely ship in all five ports,
  byte-identically conformance-gated. That's not vaporware — the render/verify/extract
  corpora are among the most heavily pinned in the repo.
- Two real adopters gate prompt drift in CI today (one TS: 22 templates + payload VOs
  behind `meta verify` in GitHub Actions; one JVM: 13 prompt files → 69 generated payload
  records, ~2.1K LOC of string assembly reduced to ~900 in the render path, and the gate
  survived a language port).

Thinner than billed:
- **It is a program, not a switch.** At the Phase-0 target the prompt surface was ~37K LOC
  across 16 sites; the blinded assessment's honest estimate was 4-6 sites in two quarters,
  and heavy conditional-assembly builders may never fully migrate. The library gives you
  per-site building blocks + a drift gate; the migration labor, orchestration, and eval
  harness are yours (deliberately, per the roadmap's "tracked outside this library repo").
- "All four pillars ship today" flattens this asymmetry. The README's own phrasing
  ("library-side building blocks are complete; MCP exposure remains") is the accurate
  version — the shorter surfaces should inherit its qualifier, not drop it.
- Parser reality: FR-006/FR-010 cover *declared* output shapes and tolerant extraction.
  Years of accumulated tag-repair heuristics in a mature adopter don't map 1:1; the
  Phase-0 assessment said so and was right to.

---

## Part 2 — Oversell audit (claim → source → verdict → fix)

Legend: **ACCURATE** — say it louder. **DEFENSIBLE** — fine with the caveat that exists or
should exist nearby. **OVERSOLD** — a prospect would feel burned; fix the sentence.
**STALE** — wrong by drift, fix mechanically.

| # | Claim | Source | Verdict | Fix |
|---|---|---|---|---|
| 1 | "Drift is structurally impossible." | metaobjects.dev homepage (after the edit-one-YAML-field example) | **OVERSOLD** — the single worst sentence in the messaging. Drift is impossible only for surfaces *derived from the metadata, regenerated, and gated in CI*. Unmodeled surfaces (hand views, ad-hoc SQL), un-wired gates, and non-PG/SQLite DBs all still drift — our own docs and the Phase-0 assessment say so. | Replace with "**Drift breaks the build.**" (true, and punchier than the false version). |
| 2 | "Make schema drift a compile-time error." | Homepage headline; video 4 title | **DEFENSIBLE** — headline compression. The mechanism is build/CI-time (`verify`) plus type-checker breakage for typed renames. | Keep the headline; make sure the first body sentence says "at build time" (it largely does). |
| 3 | "Generated code … runs without any MetaObjects dependency at runtime" / "if the packages disappear tomorrow, you keep working code" | README, llms.txt, llms-full.txt, homepage | **DEFENSIBLE-WITH-CAVEAT, currently stated too strongly.** True for the entity/model/schema tier (the TS entity file's `runtime-ts` imports are deliberately type-only and erasable). **Not literally true** for: generated TanStack hooks/grids (import `@metaobjectsdev/tanstack` + `runtime-web` at runtime), generated prompt-render helpers (import `@metaobjectsdev/render`), trace helpers, and by definition the whole runtime pillar (OMDB/ObjectManager ARE MetaObjects runtime libraries). "Disappear tomorrow" survives via installed copies + Apache-2.0, so that half is fair. | Reword to: "**No proprietary runtime.** The generated entity/model code is dependency-free; the optional client, prompt-render, and runtime tiers are ordinary Apache-2.0 packages you could vendor or fork." |
| 4 | "All four pillars ship today across all five ports" | llms.txt, llms-full.txt (README says it with the MCP qualifier) | **DEFENSIBLE-WITH-CAVEAT** — codegen/drift yes; prompt pillar = building blocks (qualifier exists in README, dropped in llms.txt's bold headline); runtime metadata's C# cell is "Roadmap" *per our own README matrix*. | Keep the sentence but link the capability matrix from it, and resolve the C#-runtime contradiction between README and llms.txt (pick the honest cell — README's). |
| 5 | Runtime pillar includes "LLM tool registration" | Homepage pillar 2, README, llms.txt ("so AI agents see typed tools generated from metadata") | **OVERSOLD** — MCP exposure is an unshipped roadmap item. Video 5 already removed this exact claim in its honesty pass; the text surfaces lag the video. | Delete or move to roadmap phrasing ("typed tool payloads are declared today; MCP exposure is on the roadmap"). |
| 6 | Video 4: "`meta verify` checks that your code, your prompts, and your database schema still agree … any mismatch fails the build" | videos.html, drift-detection video | **DEFENSIBLE-WITH-CAVEAT** — true in the demoed TS stack. A JVM/C# viewer will not learn that the schema check requires the Node CLI, nor that it's Postgres/SQLite/D1-only. | One caption/blurb line: "Schema check runs via the Node `meta` CLI (Postgres, SQLite, D1); codegen + template checks run in your own build tool." |
| 7 | Video 5: "One generic function builds a grid for any object you've described — no code generation" | videos.html, runtime-ui video | **DEFENSIBLE-WITH-CAVEAT** — true, in a React/browser app only. Server-rendered UI shops get nothing (a disqualifier the Phase-0 assessment had to spell out). | Add "in your React admin" to the blurb. Cheap, prevents the worst misread. |
| 8 | "five `metaobjects-*` Claude Code skills" | llms.txt (×2), llms-full.txt (×1) | **STALE** — six ship (`metaobjects-audit` joined the set); the identical five→six bug was already fixed in the getting-started video but not in these files. | s/five/six/ in all three spots. |
| 9 | README capability matrix: "Hand-write Spring controller per contract" (Java/Kotlin/Python REST routes); payload-VO "– (consumers use `Map`/`dict`)" for Java/Python; C# runtime "Roadmap" | README.md capability matrix | **STALE — under-claims.** Generated controllers ship and are api-contract-conformance-gated in all five ports (both lanes, including the generated artifact booted over HTTP); payload-VO codegen ships in all five ports (Spring payload records, Python payload models). The C# runtime "Roadmap" cell is the *accurate* one and should win over llms.txt. | Refresh the matrix against `CLAUDE.md` status + `registry-conformance`; make README and llms.txt agree cell-for-cell. |
| 10 | Version strings `0.15.19` / `7.7.9` | llms.txt, llms-full.txt, README | **STALE** (0.15.20 / 7.7.10 shipped) — a recurring pattern already noted in project memory. | Fold "bump llms.txt + README versions" into the release checklist, or generate the strings. |
| 11 | Exec/business video: your key business info "copied into dozens of systems" (Sales/Billing/Website) drifts; define once and "everything stays in sync" | Business overview video (metaobjects.com) | **DEFENSIBLE — but watch the analogy's edge.** The deliberate jargon-free framing is right for the audience, and the drama was already toned in the honesty re-render. The residual risk: the hub-and-spoke "systems stay in sync" picture can read as *data integration / MDM* (live system sync), which MetaObjects is not — it synchronizes *definitions and code artifacts*. | One grounding line: "one definition your teams build every system from" (definition-sync, not data-sync). No other change; simplified-for-execs did **not** cross into overpromised. |
| 12 | "2,500+ tests", "byte-identical across five ports", "five shared conformance corpora", DB support "Postgres, SQLite, D1" | Homepage, README, llms.txt | **ACCURATE** — and load-bearing. The conformance-corpus story is the most verifiable claim in the messaging and it holds (330 fixtures, per-port pass tables in `docs/CONFORMANCE.md`). The homepage listing the three supported dialects plainly is exactly the honesty the migrate story needs. | None. If anything, surface the two-lane api-contract gate ("we boot the *generated* API and test it over HTTP") — it's under-marketed. |

### Where the messaging is honest or under-claims (credit where due)

- **The README maintainer note** ("primarily a one-person, part-time project … days, not
  hours") and the **"Built AI-first" disclosure** are rare, trust-building candor. Keep both.
- **ADR-0015 is stated everywhere it matters**: llms.txt, README, and the quickstarts all
  say schema migration is Node-`meta`-only, and D1 is flagged TS-only. Nobody reading the
  docs (as opposed to skimming the homepage) will be surprised by the Node-in-CI requirement.
- **The capability matrix exists at all**, with explicit "partial" cells — most projects
  at this stage publish no such thing. Its problem is staleness, not dishonesty.
- **The videos already survived an honesty audit**: the unshipped MCP claim was cut from
  video 5, the getting-started demo was reworked to show the *real default* scaffold, and
  dramatic phrasing was toned down. The re-render discipline worked.
- **The blinded Phase-0 assessment itself did not overpromise** — its misses were all
  conservative under-predictions (it under-counted entities, under-headlined JSONB,
  under-predicted UI usage), and it volunteered a "what you will NOT get" section. The
  honesty culture demonstrably propagates into machine-generated collateral, which was
  the design's #1 feared failure mode.
- **The roadmap openly parks things** ("deferred post-1.0", "tracked outside this library
  repo") rather than implying imminence.

---

## Part 3 — What to change (ordered by burn-risk)

1. **Homepage:** replace "Drift is structurally impossible." with "Drift breaks the
   build." (row 1). Highest-priority single edit.
2. **Homepage + README + llms.txt/llms-full.txt:** reword the "no MetaObjects runtime
   dependency" claim per row 3 ("no proprietary runtime; entity/model tier is
   dependency-free; optional tiers are ordinary Apache-2.0 packages").
3. **Homepage + README + llms.txt:** remove or roadmap-qualify "LLM tool registration"
   under the runtime pillar (row 5) — match the fix already made in video 5.
4. **README capability matrix refresh** (row 9): generated-controller rows, payload-VO
   rows, and reconcile the C#-runtime cell with llms.txt (README's "Roadmap" wins).
5. **llms.txt/llms-full.txt:** five→six skills (row 8); version bump + add both to the
   release checklist (row 10).
6. **videos.html blurbs:** one line each on video 4 (Node CLI + PG/SQLite/D1 for the
   schema check) and video 5 ("in your React admin") — rows 6-7. No re-render needed;
   blurb text suffices.
7. **Positioning decision (not a copy edit):** either present runtime metadata as the
   *growing* pillar (accurate today) or pull FR-029 (metadata API + runtime-driven UI)
   forward so "equal weight" becomes true. Holding both the claim and the 1.4 schedule
   is the one structural inconsistency copy edits can't fix.
8. **Under-marketed strengths to surface:** the two-lane generated-API conformance gate;
   the drift-archaeology story (a fit assessment that finds *your own* production drift
   incidents before adoption is the strongest sales artifact this project has ever
   produced — productize it).
9. **Optional, exec video:** one grounding line to pre-empt the MDM/data-sync misread
   (row 11).

---

## Bottom line

The core tenet is materializing, with real-adopter proof: the spine drove a full
migration, survived a language port, and the drift pillar caught production-biting
incidents that the adopter's own history documents. The pillar ranking in the field is
**drift > codegen > prompts > runtime** — the messaging should stop implying uniform
equality and start selling the asymmetry (drift-first is both true and the strongest
pitch). The outward messaging is unusually honest for a project at this stage — the
capability matrix, the maintainer note, the ADR-0015 candor, and the video honesty
re-render are all better than industry norm — but four sentences outrun reality
("structurally impossible", "no runtime dependency", "LLM tool registration", the flat
"all four ship") and a stale README matrix now contradicts llms.txt in both directions.
All are fixable with copy edits except the runtime-pillar positioning, which needs either
humbler billing or FR-029.
