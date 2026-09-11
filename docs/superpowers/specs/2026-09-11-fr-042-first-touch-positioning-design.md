# FR-042 — First-touch positioning: one typed model, three verbs

_Design. 2026-09-11. Status: Draft — the headline (§6) and the third verb's name (§3) await the
maintainer's sign-off._

## 1. The problem

Every first-touch surface — the README's opening, the `docs/llms/*` summary, the metaobjects.dev
hero, the company site's hero — describes MetaObjects as an inventory or overclaims:

- The README and llms opener: *"A cross-language metadata standard for declaring typed entity
  models that drive code generation, runtime metadata access, drift detection, prompt
  construction, and capability requirements across TypeScript, Java, Kotlin, C#, and Python."*
  Five nouns, no outcome, and the least-differentiated one (code generation) first.
- metaobjects.dev: *"Make schema drift a compile-time error"*, but the gate runs in CI, not in
  the compiler. *"Four pillars. All shipping."*, when there are five and they are not equally deep.
  Corpus counts in the hero.
- The company site: *"One schema. Five languages. Zero drift."*, an overclaim the docs site was
  already corrected for.

Positioning research (2026-09-11) concluded: **lead with the model, prove it with the gate.** A
pitch that opens with a failure mode sells insurance. A pitch that opens with the model, and proves
it with the failure mode, sells a way of building.

## 2. The message

**30 seconds, spoken:**

> Every AI coding agent has the same blind spot: it writes great code inside one prompt and has no
> idea what the rest of your system believes. So the same concept gets restated in the schema, the
> API, the validators, the UI and the prompts, and every restatement is a place to drift.
> MetaObjects gives the agent one typed model of your app: entities, relationships, what each
> prompt receives, and what the software is supposed to do. Every layer's code is generated from
> it, in TypeScript, Java, Kotlin, C# or Python. The build fails the moment anything disagrees with
> it, including a feature someone says is done that nothing implements. It's open source, the
> model is YAML in your repo, and the generated code runs without it.

**Written, 3 sentences (README / landing page):**

> MetaObjects is one typed model of your application — data, API, UI, prompt payloads, and what
> the software is supposed to do — that your coding agent reads and writes, your code is generated
> from, and your build is checked against. Schema, migrations, API, validators, UI bindings and
> prompt templates are emitted idiomatically in TypeScript, Java, Kotlin, C# and Python, with no
> proprietary runtime in the output. When AI-written code, a prompt, or a claimed capability
> drifts from the model, the build fails.

**The category argument (talks, essays — not a first handshake):** *"The artifact an AI should
write is the model, not the code."*

**The scope clause — on every surface that makes the gate claim:** *"It protects what the model
declares; your hand-written logic is still yours."*

## 3. Structure — one idea, three verbs

> **One typed model of your app** — data, API, UI, prompt payloads, and what it's supposed to do —
> that your agent reads and writes.
>
> **Generate.** The boring parts are derived from it, in TypeScript, Java, Kotlin, C# and Python —
> at build time as code you own, or at runtime from the live model. Nothing proprietary in the output.
>
> **Verify.** When code, a database, a prompt, a doc page or a generated artifact disagrees with the
> model, the build fails.
>
> **Trace.** Declare what the software is supposed to do in the same model and point each claim at
> what implements it. A claim whose implementation was renamed, deleted, or never built fails the build.

- **Prompts are inside the model's scope, not a separate pillar.** "The model includes what your
  agent is told" is the sentence that separates this from a schema-first ORM, whose canonical
  artifact stops at the database.
- **Runtime metadata is a mode of Generate**, not a first-screen pillar.
- **The third verb is "Trace", not "Prove", for now.** Today requirements establish that an
  implementation exists and resolves, and MetaObjects emits test stubs; the harness is the
  adopter's. Rename it to "Prove" when a runnable check harness ships. *(Pending sign-off.)*
- **Five languages is a proof line below the fold**, not the hook: *"Ships today for TypeScript,
  Java, Kotlin, C# and Python — the same gate, byte-checked against each other."*
- **"The five pillars" remains the what-is-underneath section** (and stays in `AGENTS.md`). The
  verbs are what the pillars do; no public vocabulary is renamed.

## 4. Claims discipline

**Say:**
- "one declaration instead of N restatements, and the build fails when any copy disagrees"
- "the build fails", never "compile-time"
- "no one combines these" — about the combination, never about any single capability
- "a proven approach, twenty-five years; a unified standard, new"
- the scope clause, next to every gate claim

**Do not say:**
- "Zero drift" or "structurally impossible"
- "compile-time error"
- "Four pillars. All shipping."
- "less code" as a number
- **"the best way to code with AI"** — until FR-041 permits exactly that sentence
- "nobody else has built this"
- "topology", except for the ecosystem tier (FR-034), where it is the correct term
- "AI-native" or "for the AI era"
- corpus or fixture counts in a hero
- "idiomatic" more than once, and only beside the side-by-side proof

## 5. Surfaces and the changes to each

| Surface | Change |
|---|---|
| `README.md` opening | Replace the inventory sentence with the §2 written version; move the port and package inventory below the fold; add the scope clause. |
| `docs/llms/llms.txt`, `docs/llms/llms-full.txt` | Open with the §2 written version. **Constraint:** the `> A cross-language …` summary line is read by two gates — `scripts/finish-release.mjs` gate 5 finds it by that prefix, and `scripts/site/llms.test.ts` requires it to state the npm and Maven versions. Either keep a summary line with that prefix that states the versions, with the pitch around it, or change both gates in the same commit. |
| metaobjects.dev hero (site repo) | H1 per §6. Subline = the one-idea line. The hero visual is the rename → red → regen → green terminal (captured output through the existing snippet pipeline), replacing `meta gen`. CTAs: "Run the two-minute drift demo" and "Assess your repo — no install". Move the honesty line ("small single-language app with no LLM calls? an ORM is enough") up. Add the scope clause. Show the three verbs; pillars and the five-port side-by-side go below the fold. Remove "compile-time error", "Four pillars. All shipping." and runtime metadata from the first screen. |
| Company site hero | Replace "One schema. Five languages. Zero drift." with the business translation of the same message — mistakes are caught before they cost you — at executive altitude. |
| Agent context (`agent-context/`, always-on) | No positioning change: it teaches use, not position. Grep it for the do-not-say list and fix any hit. |

## 6. The H1 — decision pending

- **Recommended (model first):** *"One typed model of your app. Your agent writes it, your code is
  generated from it, your build is checked against it."*
- **Alternative (gate first, from the first research pass):** *"When AI-written code drifts from
  your typed model, the build fails."* Keep this one as the caption on the hero terminal whichever
  H1 wins.

## 7. Acceptance criteria

- [ ] The README, both llms mirrors, the .dev hero and the company-site hero carry the §2/§3 message.
- [ ] A grep for the §4 do-not-say list comes back clean across `README.md`, `docs/llms/`, the site's
  `www/` and `agent-context/`. Consider making it a `gates`-lane check, so the list cannot leak back.
- [ ] The llms gates are green: `finish-release` gate 5 and `scripts/site/llms.test.ts`.
- [ ] The scope clause appears wherever the gate claim does.
- [ ] No surface claims more than FR-041 has earned.

## 8. Out of scope

Renaming the pillars in `AGENTS.md` or the docs; the benchmark itself (FR-041); new metamodel
vocabulary; the essays and videos (their own content plan).
