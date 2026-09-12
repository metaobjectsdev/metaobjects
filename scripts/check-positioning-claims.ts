#!/usr/bin/env bun
/**
 * First-touch positioning gate (FR-042 §4, §7).
 *
 * The positioning work of 2026-09-11/12 produced a do-not-say list, and the list is
 * load-bearing rather than stylistic: every phrase on it either overclaims what the
 * product does ("zero drift", "structurally impossible"), misstates WHERE the check
 * runs ("compile-time error" — the gate is CI-time), or has been captured by another
 * meaning in the 2026 market ("guardrails" now means AI *security* scanning;
 * "topology" means agent-to-agent wiring). Until now the list was enforced by taste,
 * which is to say by whoever happened to remember it — and a phrase that leaks back
 * into the README costs nothing to write and is never caught.
 *
 * Scope, stated so it is not mistaken for more: this reads the first-touch surfaces
 * that live IN THIS REPO — `README.md`, both `docs/llms/*` mirrors, and
 * `agent-context/`. The two website heroes live in separate repos and are out of
 * reach here; they carry the same list by hand.
 *
 * The list governs CLAIMS, not strings. A banned phrase used for its plain technical
 * meaning inside instructions aimed at an agent is not the overclaim the list exists
 * to stop, so ALLOWED carries those cases with a written reason each — the same shape
 * as `sdk/test/no-hardcoded-metadata-dir.test.ts`. An entry without a reason is the
 * thing this gate is trying to prevent, so the reason is a required field, not a
 * comment.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const REPO = join(import.meta.dir, "..");

/** Files and directories a reader meets before they have decided anything. */
const SURFACES = ["README.md", "docs/llms", "agent-context"];
const READABLE = /\.(md|txt|ya?ml|json)$/;

export interface Banned {
  /** What to look for. Case-insensitive; `\b` where a substring would over-match. */
  pattern: RegExp;
  /** Why it is banned, printed with every hit so the fix is obvious. */
  because: string;
  /** What to write instead. */
  instead: string;
}

export const BANNED: Banned[] = [
  {
    pattern: /zero drift/i,
    because: "an overclaim: the gate CATCHES drift, it does not prevent it — generated files accept hand edits",
    instead: '"the build fails when any copy disagrees"',
  },
  {
    pattern: /structurally impossible/i,
    because: "same overclaim, stated harder",
    instead: '"now fails the build instead of reaching production"',
  },
  {
    pattern: /compile-time error/i,
    because: "misstates where the check runs — `meta verify` is a CI-time gate, not a compiler diagnostic",
    instead: '"the build fails"',
  },
  {
    pattern: /four pillars\.\s*all shipping\./i,
    because: "there are five, and they are not equally deep (the fifth ships test scaffolding in TypeScript only)",
    instead: 'name the depth: "the first four ship per-language across all five ports; the fifth …"',
  },
  {
    pattern: /guardrails?\b/i,
    because: "captured in 2026 by AI SECURITY scanning — secrets, vulnerabilities, gated merges. Our gate is semantic coherence",
    instead: '"the drift gate", "what breaks the build"',
  },
  {
    // Any preposition: the line that actually shipped on the site said "in the AI era",
    // and a pattern keyed to the FR's own wording ("for the AI era") walked straight past it.
    pattern: /\bAI-native\b|\bthe AI era\b/i,
    because: "era-branding: it dates the copy and says nothing a reader can check",
    instead: "state the mechanism — what drifts, and what fails when it does",
  },
  {
    pattern: /\btopology\b/i,
    because: "in 2025–26 LLM research it means agent-to-agent wiring (G-Designer, AgentPrune, MaAS); a well-read engineer punctures it in one sentence. Its one correct home is FR-034's ecosystem tier",
    instead: '"a typed graph with resolved links"',
  },
  {
    pattern: /nobody else has built this|no one else has built this/i,
    because: "false of every individual word — true only of the combination",
    instead: '"no one combines these"',
  },
  {
    pattern: /best way to code with AI/i,
    because: "not claimable until FR-041's benchmark licenses exactly that sentence",
    instead: '"here\'s the mechanism, here\'s how I ship, here\'s the harness — run it"',
  },
];

/**
 * Hits that are NOT the claim the list bans. Matched as an exact substring of the
 * offending line, so an allowance cannot quietly widen to the rest of the file.
 */
export const ALLOWED: Allowance[] = [
  {
    file: "agent-context/skills/metaobjects-verify/references/migration.md",
    contains: "can reach **zero drift** against a hand-built",
    reason:
      "Operational, not promotional: it states what `meta verify --db` reports to an agent " +
      "running it against an adopted database. The banned claim is 'MetaObjects gives you zero drift'.",
  },
  {
    file: "agent-context/skills/metaobjects-audit/SKILL.md",
    contains: "## Guardrails",
    reason:
      "A heading over the rules the AUDITING AGENT must follow — generic instruction vocabulary " +
      "addressed to an agent, not a product claim addressed to a buyer.",
  },
];

function walk(path: string): string[] {
  const full = join(REPO, path);
  if (statSync(full).isFile()) return READABLE.test(path) ? [path] : [];
  return readdirSync(full).flatMap((entry) => walk(join(path, entry)));
}

export interface Hit { file: string; line: number; text: string; rule: Banned }
export interface Allowance { file: string; contains: string; reason: string }
export interface SourceFile { file: string; text: string }

/**
 * The whole decision, as a pure function of the text — so the self-test can drive it in
 * both directions without a tree that violates the list. A gate whose only evidence is a
 * clean run over a compliant tree cannot tell "nothing matched" from "the pattern matches
 * nothing".
 */
export function scan(
  files: SourceFile[],
  banned: Banned[] = BANNED,
  allowed: Allowance[] = ALLOWED,
): { hits: Hit[]; orphans: Allowance[] } {
  const hits: Hit[] = [];
  for (const { file, text: body } of files) {
    body.split("\n").forEach((text, i) => {
      for (const rule of banned) {
        if (!rule.pattern.test(text)) continue;
        if (allowed.some((a) => a.file === file && text.includes(a.contains))) continue;
        hits.push({ file, line: i + 1, text: text.trim(), rule });
      }
    });
  }
  // An allowance whose text is gone is a licence nobody revoked. Deleting the sentence
  // should delete its excuse, or the next author inherits permission they never asked for.
  const orphans = allowed.filter(
    (a) => !files.some(({ file, text }) => file === a.file && text.includes(a.contains)),
  );
  return { hits, orphans };
}

// The gate itself only runs when invoked directly; importing it for the self-test must not
// scan the tree or call process.exit.
if (import.meta.main) runGate();

function runGate(): void {
const sources: SourceFile[] = SURFACES.flatMap((surface) =>
  walk(surface).map((file) => ({ file, text: readFileSync(join(REPO, file), "utf8") })),
);
const scanned = sources.length;
const { hits, orphans } = scan(sources);

if (hits.length > 0 || orphans.length > 0) {
  if (hits.length > 0) {
    console.error("✖ do-not-say phrases on a first-touch surface (FR-042 §4):\n");
    for (const h of hits) {
      console.error(`    ${h.file}:${h.line}`);
      console.error(`      ${h.text.slice(0, 140)}${h.text.length > 140 ? "…" : ""}`);
      console.error(`      why: ${h.rule.because}`);
      console.error(`      say: ${h.rule.instead}\n`);
    }
    console.error(
      "Rewrite the claim. If the hit is the plain technical meaning aimed at an agent\n" +
      "rather than a claim aimed at a reader deciding, add it to ALLOWED in\n" +
      "scripts/check-positioning-claims.ts WITH a written reason.\n",
    );
  }
  if (orphans.length > 0) {
    console.error("✖ stale ALLOWED entries — the text they excuse is gone, so delete them:\n");
    for (const o of orphans) console.error(`    ${o.file}\n      "${o.contains}"\n`);
  }
  process.exit(1);
}

console.log(
  `positioning claims: OK (${scanned} files across ${SURFACES.length} surfaces, ` +
  `${BANNED.length} phrases, ${ALLOWED.length} reasoned allowances)`,
);
}
