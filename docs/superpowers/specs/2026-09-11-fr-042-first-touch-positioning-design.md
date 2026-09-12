# FR-042 — First-touch positioning: one typed model, two verbs

_Design. 2026-09-11, revised 2026-09-12. Status: **Approved** — the headline (§6) and the verb
structure (§3) are signed off by the maintainer. The third verb was rejected outright; requirements
fold into Verify._

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

A second finding, from the 2026-09-12 market pass, sharpened the wedge to one sentence:
**context is advisory; a gate is not.** The market has converged on *context* — AGENTS.md/CLAUDE.md,
rules files, memories, skills, MCP servers, "context engineering" — and none of it can fail a
build. The pitch names that convergence and then breaks it.

## 2. The message — LOCKED

**Category line (talks / AI audiences):**

> Your agent's context should be a contract the build enforces.

**30 seconds, spoken:**

> Your coding agent writes good code inside one prompt and has no idea what the rest of your
> system believes. So the same concept gets restated in the schema, the API, the validators, the
> UI and the prompts — and every restatement is a place to drift. The industry's answer is
> context: rules files, memories, skills, MCP servers. Context is advisory — nothing breaks when
> the code stops matching it. MetaObjects gives your agent one typed model of your app —
> entities, relationships, what each prompt receives, and what the software is supposed to do.
> Every layer's code is generated from it, in TypeScript, Java, Kotlin, C# or Python. And the
> build fails the moment anything disagrees with the model, including a feature someone says is
> done that nothing implements. Open source, the model is YAML in your repo, and the generated
> code runs without us. I build everything on it.

**Written, 3 sentences (README / landing page):**

> Coding agents get context — rules files, memories, MCP servers — and context is advisory:
> nothing fails when the code stops matching it. MetaObjects gives your agent one typed model of
> your application — data, API, UI, prompt payloads, and what the software is supposed to do —
> generates each layer's code from it in TypeScript, Java, Kotlin, C# and Python with no
> proprietary runtime in the output, and fails your build when generated code, a prompt, or a
> claimed capability drifts from that model. Your hand-written logic stays yours.

**The Prisma sentence** — their 2026 hero is agent-first (*"One shared context across your stack is
all your agent needs"*, with `contract.prisma` as "the shared contract your ORM, migrations, and
data layer are all built around"). They stop at the data layer and they call it context, so they
are close enough to answer by name:

> Prisma's contract is the shape of your data. This one also covers what your agent is told and
> what your software is supposed to do — and it fails the build, because context doesn't.

**The category argument (talks, essays — not a first handshake):** *"The artifact an AI should
write is the model, not the code."*

**The scope clause — on every surface that makes the gate claim:** *"It protects what the model
declares; your hand-written logic is still yours."*

## 3. Structure — one idea, TWO verbs

> **One typed model of your app** — data, API, UI, prompt payloads, and what it's supposed to do —
> that your agent reads and writes.
>
> **Generate.** The boring parts are derived from it, in TypeScript, Java, Kotlin, C# and Python —
> at build time as code you own, or at runtime from the live model. Nothing proprietary in the output.
>
> **Verify.** The build fails when generated code drifts from the model, when a prompt's payload no
> longer matches what it's told, and when a feature someone marked done has nothing implementing it.

- **There is no third verb — requirements fold into Verify.** Ruled 2026-09-12. `meta verify`
  already runs the requirements ledger on every run, so a third verb would invent public vocabulary
  the product does not have, in a market whose words are already crowded. Folding makes the claim
  **bigger**, not smaller: Verify's scope is three failures, and the third — *a feature nothing
  implements* — is the unmatched one, because no test can fail on an absence; a test exercises code
  that exists. Do not reinstate "Trace" (ambiguous, states a mechanism rather than a value) or
  "Prove" (claims a runnable check harness that has not shipped).
- **Prompts are inside the model's scope, not a separate pillar.** "The model includes what your
  agent is told" is the sentence that separates this from a schema-first ORM, whose canonical
  artifact stops at the database.
- **Runtime metadata is a mode of Generate**, not a first-screen pillar.
- **Five languages is a proof line below the fold**, not the hook: *"Ships today for TypeScript,
  Java, Kotlin, C# and Python — the same gate, byte-checked against each other."*
- **"The five pillars" remains the what-is-underneath section** (and stays in `AGENTS.md`). The
  verbs are what the pillars do; no public vocabulary is renamed.

## 4. Claims discipline

**Say:**
- "one declaration instead of N restatements, and the build fails when any copy disagrees"
- "context is advisory; a gate is not" — the wedge, in one sentence
- "the build fails", never "compile-time"
- "no one combines these" — about the combination, never about any single capability
- "a proven approach, twenty-five years; a unified standard, new"
- the scope clause, next to every gate claim

**Do not say:**
- "Zero drift" or "structurally impossible"
- "compile-time error"
- "Four pillars. All shipping."
- "less code" as a number
- **"guardrails"** — burned 2026-09-12: in 2026 it means AI *security* scanning (secrets,
  vulnerabilities, gated merges). Our gate is semantic coherence.
- **"the best way to code with AI"** — until FR-041 permits exactly that sentence
- "nobody else has built this"
- "topology", except for the ecosystem tier (FR-034), where it is the correct term
- "AI-native" or "for the AI era"
- corpus or fixture counts in a hero
- "idiomatic" more than once, and only beside the side-by-side proof

**The list governs CLAIMS, not the literal words.** It bans these phrases where they assert
something about the product to a reader deciding whether to use it. It does not ban the same
string used for its plain technical meaning inside instructions, and two surviving hits are
ruled KEEP, so a later sweep does not churn them:

- `agent-context/skills/metaobjects-verify/references/migration.md` — *"`meta verify --db` /
  `meta migrate` can reach **zero drift** against a hand-built schema"*. That is what the command
  reports, stated to an agent operating it. The banned claim is "MetaObjects gives you zero drift".
- `agent-context/skills/metaobjects-audit/SKILL.md` — a `## Guardrails` heading over the rules the
  auditing agent must follow. Generic instruction vocabulary aimed at an agent, not at a buyer.

Both live in `agent-context/`, where an edit also rewrites five
`fixtures/agent-context-conformance/` copies — so churning them costs a cross-port fixture
regeneration and buys no positioning change. `README.md`'s and `llms-full.txt`'s *"the other four
pillars"* is likewise not the banned **"Four pillars. All shipping."** slogan.

## 5. Surfaces and the changes to each

| Surface | Change |
|---|---|
| `README.md` opening | Replace the inventory sentence with the §2 written version; move the port and package inventory below the fold; add the scope clause. |
| `docs/llms/llms.txt`, `docs/llms/llms-full.txt` | Open with the §2 written version. **Constraint:** the `> A cross-language …` summary line is read by two gates — `scripts/finish-release.mjs` gate 5 finds it by that prefix, and `scripts/site/llms.test.ts` requires it to state the npm and Maven versions. Either keep a summary line with that prefix that states the versions, with the pitch around it, or change both gates in the same commit. |
| metaobjects.dev hero (site repo) | H1 per §6. Subline = the one-idea line. The hero visual is the rename → red → regen → green terminal (captured output through the existing snippet pipeline), replacing `meta gen`. CTAs: "Run the two-minute drift demo" and "Assess your repo — no install". Move the honesty line ("small single-language app with no LLM calls? an ORM is enough") up. Add the scope clause. Show the **two** verbs; pillars and the five-port side-by-side go below the fold. Remove "compile-time error", "Four pillars. All shipping." and runtime metadata from the first screen. |
| Company site hero | Replace "One schema. Five languages. Zero drift." with the business translation of the same message — mistakes are caught before they cost you — at executive altitude. |
| Agent context (`agent-context/`, always-on) | No positioning change: it teaches use, not position. Grep it for the do-not-say list and fix any hit. |

## 6. The H1 — DECIDED (model-first)

**The H1 for metaobjects.dev:**

> One typed model of your app. Your agent writes it, your code is generated from it, your build
> is checked against it.

**The hero-terminal caption** — the gate-first line from the first research pass, kept:

> When AI-written code drifts from your typed model, the build fails.

Gate-first lost the H1 slot because it invites "my agent + Prisma already does this" before the
reader knows what the model covers. The H1 says "checked against", never "enforces": the gate is
CI-time, and "enforces" drifts toward "structurally impossible", already on the §4 list.

## 7. Acceptance criteria

- [ ] The README, both llms mirrors, the .dev hero and the company-site hero carry the §2/§3 message.
- [ ] A grep for the §4 do-not-say list comes back clean across `README.md`, `docs/llms/`, the site's
  `www/` and `agent-context/`. Consider making it a `gates`-lane check, so the list cannot leak back.
- [ ] The llms gates are green: `finish-release` gate 5 and `scripts/site/llms.test.ts`.
- [ ] The scope clause appears wherever the gate claim does.
- [ ] No surface claims more than FR-041 has earned.

## 8. What shipped, and the one piece that did not

Implemented 2026-09-12: `README.md`, both `docs/llms/*` mirrors (plus the two gates that read
their summary line — both now find it by BLOCKQUOTE POSITION, not by the prose prefix
`"> A cross-language"`, which was the inventory sentence this FR removes), the metaobjects.dev
hero + drift/pillars headings, and the metaobjects.com hero, tagline and two case-study
overclaims.

**Not shipped — the hero video.** §5 asks the .dev hero visual to become the
rename → red → regen → green terminal. The current asset is a recorded `meta gen` screen capture
(`/images/cli-demo.mp4`); replacing it needs a new recording, which is a media task, not a markup
one. Consequences, handled rather than hidden:

- The gate-first line is NOT the hero video's caption, because captioning a codegen demo with a
  drift claim is the "never demo greenfield CRUD; demo the gate" failure the positioning research
  warns about. It leads the drift section instead, which is where the hero's primary CTA now
  lands. **When the drift recording ships, move it back to the hero figcaption** — that is the
  placement this FR intends.
- The hero's primary CTA is "See what breaks the build" → `#drift`. §5 asks for "Run the
  two-minute drift demo"; there is no such page yet, and the CTA will not link to a 404. Point it
  at the demo page when one exists.

## 9. Out of scope

Renaming the pillars in `AGENTS.md` or the docs; the benchmark itself (FR-041); new metamodel
vocabulary; the essays and videos (their own content plan).
