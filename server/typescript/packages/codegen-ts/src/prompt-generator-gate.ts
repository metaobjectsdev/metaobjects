import type { MetaData } from "@metaobjectsdev/metadata";
import { TYPE_TEMPLATE, TEMPLATE_SUBTYPE_PROMPT, TEMPLATE_ATTR_RESPONSE_REF } from "@metaobjectsdev/metadata";
import type { Generator } from "./generator.js";

/**
 * Generators that turn a declared `template.*` into runnable prompt code. Names, not
 * identities, because an adopter may wrap or re-export them (ADR-0034 scaffold-and-own
 * makes owning a copy the encouraged path) and a wrapper keeps the name.
 */
const PROMPT_GENERATOR_NAMES: ReadonlySet<string> = new Set([
  "prompt-render",
  "output-parser",
  "render-helper",
  "output-prompt",
]);

/**
 * A declared prompt with no prompt generator wired produced NOTHING and said NOTHING.
 *
 * `meta gen` emitted the payload value objects (they are `object.value` nodes, which the
 * entity generator picks up) and stopped there: no `render<Name>()`, no parser, no
 * response-format fragment. `meta verify` then reported "1 template(s) clean", which reads
 * as confirmation that the prompt is fine. So the fourth pillar produced two type files and
 * a green gate, and the adopter had neither a send side nor a receive side.
 *
 * The wiring IS documented — but only in the prompts skill's per-language reference
 * fragment, which SKILL.md points at in its final line, while the skill body walks the
 * entire declaration without once saying a generator is required. Found by declaring a
 * `template.prompt` in a from-scratch app exactly as that skill teaches.
 *
 * This follows the `layout.dataGrid` precedent (#287, data-grid-gate.ts): tell the adopter
 * at `meta gen` time rather than adding a doc line that gets missed the same way. It is a
 * WARNING — the exit code is untouched — and it is **self-extinguishing**: wire any one
 * prompt generator and it goes quiet forever, so a project that has made this choice
 * deliberately is never nagged.
 *
 * It must live in the runner rather than in a generator, because the whole condition is
 * that the generator which would speak up is not running.
 */
export function warnMissingPromptGenerators(
  root: MetaData,
  generators: readonly Generator[],
  warn: (msg: string) => void,
): void {
  if (generators.some((g) => PROMPT_GENERATOR_NAMES.has(g.name))) return;

  // ADR-0039: resolving children — a template may arrive through an overlay or extends.
  const templates = root
    .children()
    .filter((c) => c.type === TYPE_TEMPLATE && c.subType === TEMPLATE_SUBTYPE_PROMPT);
  if (templates.length === 0) return;

  const names = templates.map((t) => t.name).join(", ");
  // A @responseRef is what asks for the inbound tier (ADR-0052), so a responding prompt
  // is missing strictly more than an outbound-only one. Name that, rather than making the
  // adopter infer which half is absent.
  const responding = templates.filter((t) => typeof t.attr(TEMPLATE_ATTR_RESPONSE_REF) === "string");
  const receiveHalf =
    responding.length > 0
      ? ` ${responding.length === templates.length ? "All" : `${responding.length} of them`} ` +
        `declare a @responseRef, so the parser and response-format fragment are missing too — ` +
        `add outputParser().`
      : "";

  warn(
    `${templates.length} declared template.prompt (${names}) generated no prompt code: ` +
      `no prompt generator is wired, so there is no render function to send one and nothing ` +
      `read a reply. Add promptRender() to \`generators\` in metaobjects.config.ts ` +
      `(import it from "@metaobjectsdev/codegen-ts/generators").${receiveHalf} ` +
      `The payload value objects were emitted regardless — those are object.value nodes, ` +
      `which is why this looked like it had worked.`,
  );
}
