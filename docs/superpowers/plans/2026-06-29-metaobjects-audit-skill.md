# metaobjects-audit skill — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `metaobjects-audit` agent-context skill — a 6th `metaobjects-*` skill that ships into adopter repos and audits a project for MetaObjects adoption (greenfield→deep, codegen + runtime + drift-gate + prompts + scaffold-and-own), producing a scored, prioritized, machine-readable + Markdown report.

**Architecture:** Author `agent-context/skills/metaobjects-audit/SKILL.md` (port-agnostic methodology + scoring + report + audit→action bridge) + `references/capability-checklist.md` (exhaustive, registry-grounded) + `references/{typescript,csharp,java,kotlin,python}.md` (per-port specifics + calibration). Register the name in `SKILL_NAMES`, nudge the always-on template, and regenerate the byte-gated agent-context conformance fixtures. Add one executable guard: the capability checklist must only name vocabulary present in `fixtures/registry-conformance/expected-registry.json`.

**Tech Stack:** Markdown content; TypeScript (`SKILL_NAMES` const + a Bun test); the SDK agent-context assembler (`assemble.ts`, deploy-all references) + conformance corpus (`fixtures/agent-context-conformance/`, 4 stacks).

**Source spec:** `docs/superpowers/specs/2026-06-29-metaobjects-audit-skill-design.md` (§ references below point into it).

## Global Constraints

- **Cite only real APIs/commands/generators/attrs per port** — no invented `meta` flags, generator names, or metamodel attrs (the agent-context P0 lesson). Cross-check against the live `metaobjects-{authoring,codegen,runtime-ui,prompts,verify}` skills + `docs/features/cli.md`.
- **The capability checklist is registry-grounded** — every type/subtype/attr it names must exist in `fixtures/registry-conformance/expected-registry.json`. Enforced by a test (Task 2).
- **Read-only / propose-only** — the skill never authors metadata or edits code; `metadata_sketch` is a report proposal (spec §1, §9b).
- **No single global score** — three surfaces: maturity tier + per-pillar + binary CI gate (spec §8b). Bands not decimals.
- **Calibration is mandatory** — never flag a by-design port gap (spec §10b): filter-op codegen TS-only; output-parser not Java; Python hand-wires its router; C# no ObjectManager; cut `field.byte/short/class`; TS-only `view.*` widgets; planned-not-shipped `api.*`/MCP; cross-port version skew is by design.
- **References are deploy-all** — the assembler installs every `references/*.md` regardless of stack; SKILL.md tells the agent which to read (`assemble.ts:54-69`). So `capability-checklist.md` + all 5 per-port refs ship together.
- **Run TS tests scoped:** `cd server/typescript/packages/sdk && bun test`. Conformance regen: `cd server/typescript/packages/sdk && bun scripts/regen-agent-context-conformance.ts`.
- **Public-repo hygiene**; **commit trailers** on every commit:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` / `Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky`.

## File Structure

- `agent-context/skills/metaobjects-audit/SKILL.md` — the methodology spine (Task 1).
- `agent-context/skills/metaobjects-audit/references/capability-checklist.md` — exhaustive registry-grounded checklist (Task 2).
- `agent-context/skills/metaobjects-audit/references/{typescript,csharp,java,kotlin,python}.md` — per-port specifics + calibration (Task 3).
- `server/typescript/packages/sdk/src/agent-context/types.ts:10-16` — add `"metaobjects-audit"` to `SKILL_NAMES` (Task 4).
- `agent-context/templates/always-on.md.mustache:20-23` — add "audit/adoption" to the going-deeper list (Task 4).
- `server/typescript/packages/sdk/test/agent-context-capability-grounding.test.ts` — the registry-grounding guard (Task 2).
- `fixtures/agent-context-conformance/*/expected/**` — regenerated goldens (Task 4).

---

## Task 1: Author SKILL.md (the methodology spine)

**Files:**
- Create: `agent-context/skills/metaobjects-audit/SKILL.md`

**Interfaces:**
- Produces: the skill body the assembler emits to `.claude/skills/metaobjects-audit/SKILL.md`. Must open with YAML frontmatter `name: metaobjects-audit` + a `description:` (one line, matching the other skills' frontmatter style — read `agent-context/skills/metaobjects-codegen/SKILL.md` lines 1-4 for the exact shape).

- [ ] **Step 1: Scaffold the dir + read the sibling skill shape**

```bash
mkdir -p agent-context/skills/metaobjects-audit/references
sed -n '1,6p' agent-context/skills/metaobjects-codegen/SKILL.md   # copy the frontmatter style
```

- [ ] **Step 2: Write SKILL.md** — port-agnostic; transcribe the spec into a scannable, checklist-driven skill body. Required sections, each from the cited spec section (keep it tight — methodology + pointers, not the full prose):
  1. **Frontmatter** — `name: metaobjects-audit`; `description:` ≈ "Use when assessing how well a project has adopted MetaObjects — greenfield first-pass or deep double-check; produces a scored, prioritized adoption-audit report covering codegen, runtime, drift-gates, and prompts."
  2. **Purpose + thesis** (spec §1) — the second-source-of-truth thesis; read-only/propose-only boundary; the two artifacts (`.metaobjects/adoption-audit.json` + Markdown report).
  3. **The phased checklist the agent turns into todos** (spec §2): triage (greenfield/partial/deep + owned-generators posture) → the adaptive path → the **8 review axes A–H** (one line each) → synthesize. State the **verify-don't-assume** rule (read the code behind a grep hit; a duplicate validator's *divergence* is the finding) and that axes are parallelizable but no orchestration tool is mandated.
  4. **Classification scheme** (spec §3) — the table incl. OWNED-GENERATOR + dual codegen/runtime fit + the "derives-from-metadata can't-drift" exception.
  5. **Complete capability coverage** (spec §4b) — one paragraph + "work the full `references/capability-checklist.md` on every axis."
  6. **Drift signatures** (spec §5) + **owned-codegen assessment** (spec §6) + **prompt anti-patterns** (spec §7) — the grep-then-verify hunts, condensed to bullets.
  7. **Semantic-constraint ratification** (spec §8) — the cross-language-invariant rule + the KEEP/LOCAL/DROP table; cross-field validators ARE modelable.
  8. **Scoring & maturity model** (spec §8b) — the three surfaces; "no single global score"; bands-not-decimals; grade-the-delta; lead-with-gaps.
  9. **The report + typed-finding record + audit→action bridge** (spec §9/§9b) — the report sections (scorecard first); the typed-finding field table; the dry-run→review→apply bridge mapping (`meta gen --dry-run` + `verify --codegen`); per-cutover **skill mapping** (authoring/codegen/runtime-ui/prompts/verify); the optional guided-cutover follow-on.
  10. **Guardrails** (spec §10) + **Calibration / non-defects** (spec §10b) — the parity-gate + the per-port "do NOT flag" list.
  11. **Footer** — "For this project's port specifics + the exhaustive capability checklist, read every `references/*.md` in this skill's directory" (mirrors the other skills' footer; the agent reads `capability-checklist.md` always + the matching `<port>.md`).

- [ ] **Step 3: Verify frontmatter + length sanity**

```bash
head -4 agent-context/skills/metaobjects-audit/SKILL.md         # name: metaobjects-audit + description
wc -l agent-context/skills/metaobjects-audit/SKILL.md            # expect ~180-260 lines (sibling skills are ~120-200)
```
Expected: frontmatter present; comparable in size to `metaobjects-codegen/SKILL.md`.

- [ ] **Step 4: Commit**

```bash
git add agent-context/skills/metaobjects-audit/SKILL.md
git commit -m "feat(audit-skill): SKILL.md methodology spine

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 2: Author the capability checklist + the registry-grounding guard

**Files:**
- Create: `agent-context/skills/metaobjects-audit/references/capability-checklist.md`
- Create/Test: `server/typescript/packages/sdk/test/agent-context-capability-grounding.test.ts`

**Interfaces:**
- Produces: a port-agnostic checklist where every capability line names a real type/subtype/attr; the test asserts each named token exists in `expected-registry.json`.

- [ ] **Step 1: Write the failing test first** (it will fail because the checklist file doesn't exist yet). This guard makes the "cite only real APIs" rule executable: extract every `field.<x>` / `object.<x>` / `source.<x>` / `relationship.<x>` / `identity.<x>` / `origin.<x>` / `validator.<x>` / `view.<x>` / `layout.<x>` / `template.<x>` / `attr.<x>` token + every `@attr` from the checklist, and assert each subtype + attr is present in the registry manifest.

```ts
// server/typescript/packages/sdk/test/agent-context-capability-grounding.test.ts
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "../../../../..");
const CHECKLIST = join(ROOT, "agent-context/skills/metaobjects-audit/references/capability-checklist.md");
const REGISTRY = join(ROOT, "fixtures/registry-conformance/expected-registry.json");

// Subtypes the checklist may name as illustrative-but-cut/TS-only/planned — exempt from
// the "must be in the cross-port registry" rule (the checklist explicitly flags them).
const EXEMPT_SUBTYPES = new Set<string>([
  // cut stubs (named only to say "do NOT audit for them")
  "field.byte", "field.short", "field.class",
  // TS-only view widgets (not in the cross-port registry; flagged TS-only)
  "view.text", "view.textarea", "view.date", "view.month", "view.hotlink", "view.dropdown",
  "view.radio", "view.checkbox", "view.number", "view.password", "view.hidden", "view.web",
  // planned, not yet registered (flagged "not yet in the registry")
  "api.base", "api.operational", "operation.query", "operation.command", "binding.rest",
]);

function registryTokens(): { subtypes: Set<string>; attrs: Set<string> } {
  const reg = JSON.parse(readFileSync(REGISTRY, "utf8")) as { types: Record<string, any>; commonAttrs?: Record<string, any> };
  const subtypes = new Set<string>();
  const attrs = new Set<string>(Object.keys(reg.commonAttrs ?? {}));
  for (const [type, def] of Object.entries(reg.types)) {
    for (const sub of Object.keys((def as any).subTypes ?? {})) {
      subtypes.add(`${type}.${sub}`);
      for (const a of Object.keys((def as any).subTypes[sub]?.attrs ?? {})) attrs.add(a);
    }
    for (const a of Object.keys((def as any).attrs ?? {})) attrs.add(a);
  }
  return { subtypes, attrs };
}

describe("capability checklist is registry-grounded", () => {
  const text = readFileSync(CHECKLIST, "utf8");
  const { subtypes, attrs } = registryTokens();

  test("every `type.subtype` named exists in the registry (or is an explicit exemption)", () => {
    const named = new Set(
      [...text.matchAll(/\b(object|field|source|relationship|identity|origin|validator|view|layout|template|attr)\.([a-zA-Z][a-zA-Z0-9]*)\b/g)]
        .map((m) => `${m[1]}.${m[2]}`),
    );
    const unknown = [...named].filter((t) => !subtypes.has(t) && !EXEMPT_SUBTYPES.has(t));
    expect(unknown).toEqual([]);
  });

  test("every @attr named exists in the registry", () => {
    const named = new Set([...text.matchAll(/`@([a-zA-Z][a-zA-Z0-9]*)`/g)].map((m) => m[1]!));
    const unknown = [...named].filter((a) => !attrs.has(a));
    // Allow doc-only/config attrs not in the metamodel registry (apiPrefix etc. aren't @attrs anyway).
    expect(unknown).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (checklist file missing).

Run: `cd server/typescript/packages/sdk && bun test test/agent-context-capability-grounding.test.ts`
Expected: FAIL (ENOENT on the checklist path).

> **Adaptation note for the implementer:** first inspect the real manifest shape — `python3 -c "import json;d=json.load(open('fixtures/registry-conformance/expected-registry.json'));print(list(d)); import sys; t=d['types']; k=next(iter(t)); print(k, list(t[k]))"` — and adjust `registryTokens()` to the actual nesting (the agent that mapped the metamodel reported keys `types`/`commonAttrs`/`defaultSubTypes`, with per-subtype `attrs`). The test must pass against the REAL manifest before you trust it.

- [ ] **Step 3: Write `capability-checklist.md`** from spec §4b + the metamodel inventory: a flat, grouped checklist (Object / Field / Source / Relationship / Identity / Origin / Validator / View+Layout / Template / Attr / common doc attrs / cross-cutting). Each line: the capability (real `type.subtype` + key `@attrs`) → its one-line audit hunt ("hand-written X that metadata describes"). Carry the §10b calibration flags **inline** (mark cut/TS-only/planned tokens with their "do NOT audit / TS-only / not-yet-shipped" note so the test's exemptions are visible to a human reader too).

- [ ] **Step 4: Run the test — iterate to PASS.** Any token the test rejects is either a typo (fix the checklist) or a genuinely-absent vocabulary (remove it / move to the exemption note). NEVER add a fake token to the registry to make the test pass.

Run: `cd server/typescript/packages/sdk && bun test test/agent-context-capability-grounding.test.ts`
Expected: PASS (both assertions `[]`).

- [ ] **Step 5: Commit**

```bash
git add agent-context/skills/metaobjects-audit/references/capability-checklist.md server/typescript/packages/sdk/test/agent-context-capability-grounding.test.ts
git commit -m "feat(audit-skill): registry-grounded capability checklist + grounding test

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 3: Author the per-port reference fragments

**Files:**
- Create: `agent-context/skills/metaobjects-audit/references/{typescript,csharp,java,kotlin,python}.md`

**Interfaces:**
- Produces: 5 deploy-all reference fragments. Each (≈40–90 lines) carries, for that port: (a) how to find generated dirs (the `@generated` header + the port's output convention) and run `gen`/`verify` (the real per-port command — `meta`/`dotnet meta`/`mvn metaobjects:*`/`metaobjects`); (b) the per-language drift signatures (`model_dump`/Pydantic for Python, Zod/Drizzle for TS, records for Java/C#, Exposed for Kotlin); (c) the owned-generators location + the deprecated-export name to grep (TS: `@metaobjectsdev/codegen-ts/generators`); (d) the **version-skew check** for that ecosystem (resolved CLI deps: npm `node_modules`, Maven resolved version, pip, NuGet); (e) **that port's §10b calibration gaps** ("Java hand-writes the output parser — don't flag"; "Python hand-wires the FastAPI router"; "C# has no ObjectManager tier"; "non-TS ports defer filter-op codegen").

- [ ] **Step 1: Cross-check the real per-port surfaces** before writing — read the matching `references/<port>.md` of the sibling skills so commands/generator names/package names are exact:

```bash
for p in typescript csharp java kotlin python; do echo "=== $p ==="; \
  cat agent-context/skills/metaobjects-codegen/references/$p.md 2>/dev/null | head -40; done
cat agent-context/skills/metaobjects-verify/references/migration.md | head -30
```

- [ ] **Step 2: Write the 5 fragments**, each grounded in the sibling-skill commands (no invented flags). Calibration block per port is mandatory.

- [ ] **Step 3: Sanity-check no invented commands** — grep the new fragments for command tokens and confirm each appears in a sibling skill or `docs/features/cli.md`:

```bash
grep -hoE "(dotnet )?meta(objects)? [a-z-]+|mvn metaobjects:[a-z]+" agent-context/skills/metaobjects-audit/references/*.md | sort -u
# cross-check each against:
grep -rhoE "(dotnet )?meta(objects)? [a-z-]+|mvn metaobjects:[a-z]+" agent-context/skills/metaobjects-*/references/ docs/features/cli.md | sort -u
```
Expected: every command in the audit refs appears in the cross-check set.

- [ ] **Step 4: Commit**

```bash
git add agent-context/skills/metaobjects-audit/references/
git commit -m "feat(audit-skill): per-port reference fragments + calibration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 4: Register in SKILL_NAMES + nudge always-on + regenerate conformance

**Files:**
- Modify: `server/typescript/packages/sdk/src/agent-context/types.ts:10-16`
- Modify: `agent-context/templates/always-on.md.mustache:20-23`
- Modify (regenerated): `fixtures/agent-context-conformance/*/expected/**`

**Interfaces:**
- Consumes: the skill dir from Tasks 1–3 (the assembler reads it).
- Produces: `SKILL_NAMES` includes `"metaobjects-audit"`; the assembler emits the new skill + refs to every stack; the conformance goldens match.

- [ ] **Step 1: Add the name to `SKILL_NAMES`** (keep it last, after `metaobjects-verify`):

```ts
export const SKILL_NAMES = [
  "metaobjects-authoring",
  "metaobjects-codegen",
  "metaobjects-runtime-ui",
  "metaobjects-prompts",
  "metaobjects-verify",
  "metaobjects-audit",
] as const;
```

- [ ] **Step 2: Nudge the always-on template** so the skill is discoverable. In `agent-context/templates/always-on.md.mustache`, change the going-deeper line to include audit:

```
For authoring, codegen, runtime/UI, prompts, verify, or adoption-audit work, use the
matching `metaobjects-*` skill — its body links the `references/<lang>.md` fragment
installed for this project's stack.
```

- [ ] **Step 3: Run the conformance test — expect FAIL** (goldens now lack the new skill):

Run: `cd server/typescript/packages/sdk && bun test test/agent-context-conformance.test.ts`
Expected: FAIL — emitted set includes new `.claude/skills/metaobjects-audit/**` files + the changed always-on line, not in `expected/`.

- [ ] **Step 4: Regenerate the goldens** (this is an intentional content change — regen is the sanctioned update path):

Run: `cd server/typescript/packages/sdk && bun scripts/regen-agent-context-conformance.ts`
Expected: prints `<stack> -> N files` for each of the 4 stacks (N grew by the audit SKILL.md + 6 references).

- [ ] **Step 5: Re-run conformance — expect PASS**, and typecheck the SKILL_NAMES change:

Run: `cd server/typescript/packages/sdk && bun test test/agent-context-conformance.test.ts && bun run typecheck`
Expected: both PASS. (Confirm the new files appear in each `fixtures/agent-context-conformance/<stack>/expected/.claude/skills/metaobjects-audit/`.)

- [ ] **Step 6: Spot-check a regenerated golden** has the skill + the always-on nudge:

```bash
ls fixtures/agent-context-conformance/python/expected/.claude/skills/metaobjects-audit/references/
grep -l "adoption-audit" fixtures/agent-context-conformance/*/expected/.metaobjects/AGENTS.md
```
Expected: SKILL.md + capability-checklist.md + 5 per-port refs present; AGENTS.md mentions adoption-audit.

- [ ] **Step 7: Commit**

```bash
git add server/typescript/packages/sdk/src/agent-context/types.ts agent-context/templates/always-on.md.mustache fixtures/agent-context-conformance/
git commit -m "feat(audit-skill): register metaobjects-audit in SKILL_NAMES + regen conformance

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01LuZWKnWzYGVnESijL7uuky"
```

---

## Task 5: Content review + final verification (native per-port emit)

**Files:** none new — verification + fixups only.

- [ ] **Step 1: Content review for invented APIs (the P0 lesson).** Re-read SKILL.md + all references; confirm every `meta`/`dotnet meta`/`mvn`/`metaobjects` command, generator name, and metamodel attr is real (cross-checked in Tasks 2–3). Fix any drift. The capability-grounding test (Task 2) covers the metamodel vocabulary; this pass covers commands + generator names + prose claims.

- [ ] **Step 2: Full sdk suite + workspace typecheck**

Run: `cd server/typescript/packages/sdk && bun test`
Run (repo root): `bun run --filter '*' typecheck`
Expected: green (the new skill is content; the only code change is the `SKILL_NAMES` const + the new test).

- [ ] **Step 3: Verify native per-port emit is unaffected.** The Python/JVM/C# `agent-docs` paths bundle the same `agent-context/` tree (gated by `fixtures/agent-context-conformance/`). The regenerated fixtures already prove byte-identical assembly; confirm the bundle step still passes its own gate if a quick one exists:

```bash
# sdk bundles the agent-context tree into the package at build; confirm it includes the new skill:
cd server/typescript/packages/sdk && bun run build 2>&1 | tail -3 && \
  ls dist/agent-context/skills/metaobjects-audit/ 2>/dev/null || ls agent-context/skills/metaobjects-audit/
```
Expected: the bundled/contained tree includes `metaobjects-audit/` with SKILL.md + references. (If a per-port agent-context conformance corpus exists under `fixtures/agent-context-conformance/` beyond the TS one, it's the same byte-gated tree — already regenerated in Task 4.)

- [ ] **Step 4: Confirm clean tree + proceed to the no-mistakes gate** (isolated worktree under the developer's home, `bun install` so the pre-push TS gate runs, `--skip=ci`, admin-merge after local green — the established flow). The conformance + grounding tests are the substantive gates; CI's flaky java-reactor is not relied upon.

---

## Self-Review (against the spec)

- **§1 purpose/boundary/artifacts** → Task 1 (SKILL.md purpose + two artifacts + read-only).
- **§2 triage + 8 axes + verify-discipline** → Task 1 (the phased checklist).
- **§3 classification (dual-axis + OWNED-GENERATOR)** → Task 1.
- **§4 candidacy / §4b capability checklist** → Task 1 (pointer) + Task 2 (the exhaustive checklist + grounding test).
- **§5 drift signatures / §6 owned-codegen / §7 prompt pillar** → Task 1 (condensed hunts) + Task 2 (capability coverage).
- **§8 semantic ratification / §8b scoring** → Task 1.
- **§9 report / §9b typed findings + audit→action bridge** → Task 1.
- **§10 guardrails / §10b calibration** → Task 1 (SKILL.md) + Task 3 (per-port calibration blocks).
- **§11 build (SKILL_NAMES, deploy-all refs, conformance regen, content review, registry-diff)** → Task 4 (registration + regen) + Task 2 (registry-diff test) + Task 5 (content review + native emit).
- **§12 out-of-scope** → nothing built here (guided-cutover + codemods are deferred; the skill only references them).

Placeholder scan: the content tasks specify required sections + cited spec sections + executable checks rather than full prose (a skill body is authored content, not function code); the two automated gates (capability-grounding test + conformance regen) + the command cross-checks make completeness verifiable. Type consistency: `SKILL_NAMES` member string `"metaobjects-audit"` matches the dir name `agent-context/skills/metaobjects-audit/` everywhere.
