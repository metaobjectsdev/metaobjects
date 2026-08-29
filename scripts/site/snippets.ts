import type { Lang } from "./highlight-code.js";

/**
 * THE single registry of snippet ids.
 *
 * The excerpt test, the payload builder and the site's HTML placeholders all need
 * the same id set. Hand-typing it three times is exactly how an id ends up in the
 * payload with no page referencing it — which makes the bijection check throw and
 * fails both the release preflight and every deploy. Everything reads this.
 *
 * Three kinds, one per source of truth:
 *   marker      a HAND-AUTHORED file, delimited in place by `# >>> snippet:` markers
 *   excerpt     MACHINE-OWNED output, whose committed excerpt is gated as an
 *               in-order subsequence of the real generated file
 *   transcript  live CLI output, captured by running the tool
 *
 * Paths are repo-relative.
 */
export type SnippetSource =
  | { kind: "marker"; file: string; lang: Lang }
  | { kind: "excerpt"; inline: string; full: string; lang: Lang }
  | { kind: "transcript"; cwd: string; argv: string[] };

const SHOWCASE = "examples/showcase";
const ADVANCED = "examples/advanced-modeling";

export const SNIPPETS: Record<string, SnippetSource> = {
  // ── The five-language section: one small entity, every port ────────────────
  "showcase-model": {
    kind: "marker", lang: "ts",
    file: `${SHOWCASE}/metaobjects/meta.subscriber.yaml`,
  },
  "ts-entity": {
    kind: "excerpt", lang: "ts",
    inline: `${SHOWCASE}/inline/ts-entity.txt`,
    full: `${SHOWCASE}/generated/ts/Subscriber.ts`,
  },

  // ── The fifth pillar: requirements and testing ─────────────────────────────
  "showcase-requirement": {
    kind: "marker", lang: "ts",
    file: `${SHOWCASE}/metaobjects/meta.subscriber.yaml`,
  },
  "ts-requirement-test": {
    kind: "excerpt", lang: "ts",
    inline: `${SHOWCASE}/inline/ts-requirement-test.txt`,
    full: `${SHOWCASE}/generated/ts/requirements/subscriberCanBePausedWithoutErasingHistory.field.enum.test.ts`,
  },

  // ── The prompts article ────────────────────────────────────────────────────
  "showcase-prompt": {
    kind: "marker", lang: "ts",
    file: `${SHOWCASE}/metaobjects/meta.subscriber.yaml`,
  },
  "verify-transcript": {
    kind: "transcript",
    cwd: `${SHOWCASE}/drift`,
    // --prompts templates is REQUIRED: verify's default prompts dir is `prompts`
    // and this fixture's text lives in templates/, so omitting it yields
    // ERR_PARTIAL_UNRESOLVED instead of the payload-drift error the page is about.
    argv: ["verify", "--templates", "--prompts", "templates"],
  },

  // ── "The metamodel goes deep": advanced-modeling ───────────────────────────
  "deep-model": {
    kind: "marker", lang: "ts",
    file: `${ADVANCED}/metaobjects/meta.catalog.yaml`,
  },
  "deep-validators": {
    kind: "excerpt", lang: "ts",
    inline: `${SHOWCASE}/inline/deep-validators.txt`,
    full: `${ADVANCED}/src/generated/Author.ts`,
  },
  "deep-currency": {
    kind: "excerpt", lang: "ts",
    inline: `${SHOWCASE}/inline/deep-currency.txt`,
    full: `${ADVANCED}/src/generated/Program.ts`,
  },
  "deep-projection": {
    kind: "excerpt", lang: "ts",
    inline: `${SHOWCASE}/inline/deep-projection.txt`,
    full: `${ADVANCED}/src/generated/ProgramSummary.ts`,
  },
};
