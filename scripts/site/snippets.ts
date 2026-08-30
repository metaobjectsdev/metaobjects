import type { Lang } from "./highlight-code.js";

/**
 * THE single registry of snippet ids.
 *
 * The excerpt test, the payload builder and the site's HTML placeholders all need
 * the same id set. Hand-typing it three times is exactly how an id ends up in the
 * payload with no page referencing it — which makes the bijection check throw and
 * fails both the release preflight and every deploy. Everything reads this.
 *
 * Four kinds, one per source of truth:
 *   marker      a HAND-AUTHORED file, delimited in place by `# >>> snippet:` markers
 *   excerpt     MACHINE-OWNED output, whose committed excerpt is gated as an
 *               in-order subsequence of the real generated file
 *   whole       MACHINE-OWNED output short enough to publish ENTIRE. No excerpt to
 *               keep in sync and no subsequence gate — the published text IS the
 *               file, which is a stricter guarantee than any excerpt can make.
 *               Use it only when cutting would drop something load-bearing; an
 *               8-line CREATE TABLE has no line to spare.
 *   transcript  live CLI output, captured by running the tool. Carries `expect`: the
 *               diagnostic the run must produce, so the block cannot silently become a
 *               screenshot of a different failure.
 *
 * Paths are repo-relative.
 */
export type SnippetSource =
  | { kind: "marker"; file: string; lang: Lang }
  | { kind: "excerpt"; inline: string; full: string; lang: Lang }
  | { kind: "whole"; file: string; lang: Lang }
  /** `expect`: a token the captured output MUST contain — see the transcript gate. */
  | { kind: "transcript"; cwd: string; argv: string[]; expect: string };

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
  "python-model": {
    kind: "excerpt", lang: "python",
    inline: `${SHOWCASE}/inline/python-model.txt`,
    full: `${SHOWCASE}/generated/python/Subscriber.py`,
  },
  "csharp-entity": {
    kind: "excerpt", lang: "csharp",
    inline: `${SHOWCASE}/inline/csharp-entity.txt`,
    full: `${SHOWCASE}/generated/csharp/Subscriber.g.cs`,
  },
  "java-dto": {
    kind: "excerpt", lang: "java",
    inline: `${SHOWCASE}/inline/java-dto.txt`,
    full: `${SHOWCASE}/generated/java/acme/SubscriberDto.java`,
  },
  "kotlin-entity": {
    kind: "excerpt", lang: "kotlin",
    inline: `${SHOWCASE}/inline/kotlin-entity.txt`,
    full: `${SHOWCASE}/generated/kotlin/acme/Subscriber.kt`,
  },
  // The DDL `meta migrate` emits for the same model. Published WHOLE: at eight
  // lines every one carries something the model declared — the AUTOINCREMENT from
  // `generation: increment`, the VARCHAR(320) from `maxLength`, and the CHECK from
  // the enum's `values`.
  "sql-migration": {
    kind: "whole", lang: "sql",
    file: `${SHOWCASE}/generated/sql/init/up.sql`,
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
    // The page publishes this block to demonstrate THIS diagnostic. A non-zero exit
    // alone would let a fixture failing for an unrelated reason keep publishing, so the
    // builder asserts the code appears.
    expect: "ERR_VAR_NOT_ON_PAYLOAD",
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
