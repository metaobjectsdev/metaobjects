# Prompt Construction — Fourth Pillar Messaging Rollout — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This is a content/messaging rollout — "tests" are site builds, hygiene greps, and cross-surface consistency checks, not unit tests.

**Goal:** Propagate one positioning decision — *prompt construction (FR-004) is MetaObjects' fourth pillar, landing in 7.0.0* — consistently across in-repo docs, the public landing site, the commercial site, and a new essay.

**Architecture:** Edit four separate git repos in sequence (docs → public site → commercial site → essay) so the essay rests on settled messaging. Through-line: "the prompt is code." Honesty constraint: the fourth pillar is co-equal in vision but marked "landing in 7.0.0," never present-tense shipped.

**Tech Stack:** Markdown (specs + essay), static HTML + plaintext (`metaobjects.dev`), Eleventy/Nunjucks (`<commercial-site>`, `<personal-site>`).

**Repo paths (local sibling checkouts; genericized — adjust to your machine):**
- This repo: `metaobjects/` (PUBLIC)
- `metaobjects.dev/` (PUBLIC)
- `<commercial-site>/` (PRIVATE)
- `<personal-site>/` (PRIVATE)

---

## Task 1: In-repo strategy + related docs (this repo, PUBLIC)

**Files:**
- Modify: `spec/roadmap.md` (H6 entry; Java line FR-003 note)
- Modify: `spec/README.md` (fourth-pillar mention + 7.0.0 pointer)
- Modify: `CLAUDE.md` (Three pillars → four; Status note)

- [ ] **Step 1: Rewrite H6 in `spec/roadmap.md`.** Replace the placeholder `H6 — AI-collaboration capabilities expansion (TBD) / Additional AI-collaboration features layered on the MetaObjects toolchain.` with a concrete entry naming prompt construction as the fourth pillar, citing the FR-004 design doc, version-targeted 7.0.0. Add an FR-003 reference to the Java section (the 7.0.0 consolidation, OMDB port, projections, migration) — cite `docs/superpowers/specs/2026-05-22-fr-003-...md` and `...fr-004-...md`.

- [ ] **Step 2: Update `spec/README.md`.** In the "consumed by" / capabilities framing, add a fourth bullet for prompt construction marked "Planned for 7.0.0," pointing to the FR-004 design doc. Do NOT add normative `prompt.*` vocabulary.

- [ ] **Step 3: Update `CLAUDE.md`.** Change the "## Three pillars" heading + intro to four; add a fourth pillar item "**Prompt construction** (landing in 7.0.0)" with one sentence (typed payload = projection, externalized provider-resolved text, byte-identical render, build-time prompt↔payload drift). In "## Status", add one line that FR-003/FR-004 specs are written and define the 7.0.0 Java line + fourth pillar.

- [ ] **Step 4: Verify restraint + consistency.** Run: `grep -rn "prompt" spec/metamodel.md spec/wire-format.md spec/conformance-tests.md` — expected: no new normative vocabulary added (forward-pointer only if any). Run: `grep -rni "four pillars\|fourth pillar\|7.0.0" spec/roadmap.md spec/README.md CLAUDE.md` — expected: present and consistent.

- [ ] **Step 5: Hygiene check.** Run: `git -C . diff` and scan for any consumer-project name or absolute home path. Expected: none (this repo stays generic).

- [ ] **Step 6: Commit (on request, branch first if on default branch).**

```bash
git checkout -b docs/prompt-construction-fourth-pillar
git add spec/roadmap.md spec/README.md CLAUDE.md docs/superpowers/specs/2026-05-22-prompt-construction-fourth-pillar-rollout-design.md docs/superpowers/plans/2026-05-22-prompt-construction-fourth-pillar-rollout.md
git commit -m "docs: position prompt construction as the fourth pillar (7.0.0)"
```

---

## Task 2: Public landing — `metaobjects.dev` (PUBLIC)

**Files:**
- Modify: `metaobjects.dev/www/index.html` (pillars section, lines 52-69)
- Modify: `metaobjects.dev/www/llms.txt` (three → four; essay link)
- Modify: `metaobjects.dev/www/llms-full.txt` (lines 11, 21, 23 + new subsection)

- [ ] **Step 1: Add the fourth pillar card in `index.html`.** Change `<h2 class="section-label">Three pillars</h2>` → `Four pillars`. After the "Drift detection" `<article class="pillar">` (closes line 67), add:

```html
        <article class="pillar">
          <h3>Prompt construction <span class="status status-planned">7.0.0</span></h3>
          <p>The prompt is code too. Declare a prompt's payload as a typed projection, keep its text external and provider-resolved, and render it byte-identically across languages — with build-time drift detection between a prompt and the data it consumes. Landing in 7.0.0.</p>
        </article>
```

- [ ] **Step 2: Update `llms.txt`.** Change "ships three capabilities of equal weight" → "four capabilities" and add a fourth bullet under "## The three pillars" (rename heading to "## The four pillars"):

```markdown
- **Prompt construction** (landing in 7.0.0) -- treat LLM prompts as governed metadata: a typed payload (a projection), external provider-resolved prompt text, byte-identical cross-language render, and build-time prompt-to-payload drift detection.
```
In "## Author and context," add a link to the new essay: `[The prompt is code — and yours is drifting too](https://<personal-site>/writing/the-prompt-is-code/)`.

- [ ] **Step 3: Update `llms-full.txt`.** Read lines 1-60 first. Change line 11 "drives three capabilities" → "four capabilities (the fourth landing in 7.0.0)"; rename "## The three pillars" (line 21) → "## The four pillars"; update line 23 "All three pillars" → "Three pillars ship today; a fourth — prompt construction — is committed for 7.0.0." Add a `### Prompt construction (7.0.0)` subsection after the Drift detection subsection mirroring the llms.txt bullet, one paragraph.

- [ ] **Step 4: Build + verify.** Run: `cd metaobjects.dev && (npm run build 2>/dev/null || true)` then `grep -rn "Four pillars\|four capabilities\|Prompt construction" www/`. Expected: present in index.html + both llms files. Confirm no `npm`-build is required (it's a static `www/` dir) — if no build script, just verify files.

- [ ] **Step 5: Hygiene check** (PUBLIC repo). Run: `git -C ../metaobjects.dev diff | grep -niE "<private-client-name>|/home/"`. Expected: no matches.

- [ ] **Step 6: Commit (on request).**

```bash
git -C ../metaobjects.dev add www/index.html www/llms.txt www/llms-full.txt
git -C ../metaobjects.dev commit -m "feat: add prompt construction as the fourth pillar (7.0.0)"
```

---

## Task 3: Commercial site — `<commercial-site>` (PRIVATE)

**Files:**
- Read first: `<commercial-site>/src/index.njk`, `<commercial-site>/src/_data/site.json`
- Modify: whichever node carries the capability/pillar messaging (determined from the read)

- [ ] **Step 1: Read structure.** Run: `sed -n '1,200p' src/index.njk` and `cat src/_data/site.json`. Identify the section listing capabilities/pillars (likely a features/pillars block in `index.njk` or a `pillars` array in `site.json`).

- [ ] **Step 2: Add the fourth pillar / capability.** Mirror the four-pillar messaging with an enterprise framing: "Prompt construction (7.0.0) — govern your LLM prompts like code: typed payloads, externalized provider-resolved text, byte-identical render, and build-time prompt drift detection so payload bloat and token cost stay visible." Match the site's existing copy voice and data shape (array entry vs. HTML block).

- [ ] **Step 3: Build + verify.** Run: `cd <commercial-site> && npm run build`. Expected: Eleventy build succeeds. Then `grep -rn "Prompt construction" dist/`. Expected: rendered.

- [ ] **Step 4: Commit (on request).**

```bash
git -C ../<commercial-site> add -A
git -C ../<commercial-site> commit -m "feat: add prompt construction pillar (7.0.0) to homepage"
```

---

## Task 4: Essay — `<personal-site>` (PRIVATE; published publicly)

**Files:**
- Create: `<personal-site>/src/writing/2026-05-22-the-prompt-is-code.md`

- [ ] **Step 1: Write the essay.** Frontmatter:

```yaml
---
layout: post.njk
title: "The prompt is code — and yours is drifting too"
date: 2026-05-22
tags:
  - AI
  - architecture
  - metaobjects
excerpt: "<one-sentence hook: the AI-drift thesis extends from generated code to the prompts themselves; MetaObjects' fourth pillar treats prompts as governed metadata.>"
---
```

Body — first-person voice matching the prior two essays, Roman-numeral sections:
  - **I.** Series recap (link essays 1 & 2) → turn the drift lens on the prompts themselves.
  - **II.** The hidden drift in prompts — imperative `StringBuilder` assembly, repos read *inside* the builder (untestable without a live DB), the same rules triplicated, invisible payload bloat, a renamed field silently breaking a prompt. Ground in the author's own game-NPC prompt work (generic framing; do not name the game or employer); enterprise framing stays generic (no employer named).
  - **III.** A prompt is just **(data + text + render)** — each part already governed by metadata.
  - **IV.** The fourth pillar — Prompt construction: typed payload = a projection (the spine proving itself); externalized provider-resolved text; byte-identical cross-language render (Mustache + conformance); build-time prompt↔payload drift (`verify`). Map each to codegen/runtime/drift.
  - **V.** Why it had to be metadata: cross-language byte-identical, no lock-in, the provider seam (static → A/B → evolutionary) without touching metadata or engine.
  - **VI.** What it means for your stack (enterprise-scale framing, generic).
  - **VII.** What's next — 7.0.0 (FR-003 substrate first, then FR-004); link to metaobjects.dev. Series-continuation hook to `<personal-site>/writing`.

  Do NOT add an employer/client disclosure tag (per the grounding decision).

- [ ] **Step 2: Build + preview.** Run: `cd <personal-site> && npm run build`. Expected: build succeeds; `dist/writing/the-prompt-is-code/index.html` exists (Eleventy strips the date prefix from the slug).

- [ ] **Step 3: Verify URL + cross-links.** Run: `ls dist/writing/the-prompt-is-code/` and `grep -rn "the-prompt-is-code\|metaobjects-ai-drift\|ai-stack-missing-architecture" dist/writing/the-prompt-is-code/index.html`. Expected: page renders; back-links to prior essays resolve.

- [ ] **Step 4: Add forward-links from prior essays (optional).** If essay 2 promised "the next will dig into..." — leave as-is unless updating its "What's next" to point here is desired. (Defer to user.)

- [ ] **Step 5: Commit (on request).**

```bash
git -C ../<personal-site> add src/writing/2026-05-22-the-prompt-is-code.md
git -C ../<personal-site> commit -m "writing: add 'The prompt is code' (essay 3)"
```

---

## Self-review notes

- **Spec coverage:** Surface 1 → Task 1; Surface 2 → Task 2; Surface 3 → Task 3; Surface 4 → Task 4. Cross-cutting hygiene/sequencing/commits embedded per task. All covered.
- **Honesty constraint:** every surface marks the fourth pillar "7.0.0"/"landing"/"committed," never present-tense shipped. Verified in Tasks 1-4 copy.
- **Hygiene:** public surfaces (Tasks 1-2) carry explicit grep checks for consumer names + home paths.
