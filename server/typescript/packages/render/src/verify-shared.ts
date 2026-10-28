// What both template engines' drift checks share: the finding codes, the payload
// field-tree shape, the options, and the two post-walk checks (`@requiredSlots`,
// `@requiredTags`) that read only what the walk collected. Kept apart from
// verify.ts so the Mustache walk and the Jinja walk (jinja/verify.ts) import one
// definition without importing each other.

import type { Provider } from "./provider.js";
import type { TemplateEngine } from "./engine.js";

/** A template variable references a field the (contextual) payload does not declare. */
export const ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD";
/** A partial / `{% include %}` / `{% import %}` / `{% extends %}` ref does not resolve in the provider. */
export const ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED";
/** A declared @requiredSlots slot is never referenced by the template (warning). */
export const ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED";
/** A declared @requiredTags output tag is absent from the template text. */
export const ERR_OUTPUT_TAG_MISSING = "ERR_OUTPUT_TAG_MISSING";
/**
 * Jinja: a payload reference the check cannot resolve without running the template —
 * a dynamic key on an object (`user[key]`), a computed `attribute=` argument, or a
 * template name that is an expression (`{% include name %}`). Reported, never passed.
 */
export const ERR_TEMPLATE_NOT_STATIC = "ERR_TEMPLATE_NOT_STATIC";
/** Jinja: the template text does not parse. path = the parser's message. */
export const ERR_TEMPLATE_SYNTAX = "ERR_TEMPLATE_SYNTAX";
/**
 * A body is written for an engine this port does not run (Java, Kotlin and C# run
 * Mustache only, so a `.jinja` template there is refused with this code).
 */
export const ERR_TEMPLATE_ENGINE_UNSUPPORTED = "ERR_TEMPLATE_ENGINE_UNSUPPORTED";

/**
 * A plain field-tree node mirroring an `object.value` view-object's field walk.
 * `fields` present → a context-pushing field (object / array-of-object); absent
 * → a scalar (string/number/boolean/scalar-array). `isArray` is the field's
 * effective array-ness: with `fields` it is a list of objects, without it a list
 * of scalars.
 */
export interface PayloadField {
  name: string;
  fields?: PayloadField[];
  isArray?: boolean;
}

export interface VerifyError {
  code: string;
  /** The offending variable path, partial ref, or slot name. */
  path: string;
}

export interface VerifyOptions {
  /** When given, partials / includes are resolved + their bodies recursed. */
  provider?: Provider;
  /** Slots that MUST be referenced; an unused one is reported as a warning. */
  requiredSlots?: string[];
  /**
   * Output tags the rendered text is contracted to contain. Each must appear as
   * both an opening form (`<tag` followed by `>` or whitespace, so attributes are
   * allowed) and a closing `</tag>` — across the body AND resolved partials.
   */
  requiredTags?: string[];
  /** The engine the text is written for. Default: Mustache. */
  engine?: TemplateEngine;
}

/** How deep partial / include resolution recurses before it stops. */
export const MAX_DEPTH = 32;

// An opening tag is `<tag` immediately followed by `>` or XML whitespace, so
// attributes are allowed (`<answer foo="1">`) but a longer name is not over-matched
// (`<answers>` does not satisfy `answer`).
const TAG_OPEN_DELIMS = new Set([">", " ", "\t", "\n", "\r"]);

function hasOpenTag(text: string, tag: string): boolean {
  const needle = `<${tag}`;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + 1)) {
    const next = text[i + needle.length];
    if (next !== undefined && TAG_OPEN_DELIMS.has(next)) return true;
  }
  return false;
}

// A closing tag is the exact literal `</tag>`. A self-closing `<tag/>` has no such
// form, so it never satisfies a required tag — these wrap content a parser reads.
function hasCloseTag(text: string, tag: string): boolean {
  return text.includes(`</${tag}>`);
}

/**
 * The checks that run after a walk: every `requiredSlots` name must have been
 * referenced at the payload root, and every `requiredTags` tag must appear (open
 * and close) somewhere in the body plus its resolved partials (`staticTexts`).
 */
export function slotAndTagFindings(
  referencedAtRoot: ReadonlySet<string>,
  staticTexts: readonly string[],
  opts: VerifyOptions | undefined,
): VerifyError[] {
  const errors: VerifyError[] = [];
  for (const slot of opts?.requiredSlots ?? []) {
    if (!referencedAtRoot.has(slot)) errors.push({ code: ERR_REQUIRED_SLOT_UNUSED, path: slot });
  }
  const requiredTags = opts?.requiredTags ?? [];
  if (requiredTags.length > 0) {
    // Scan body + resolved partials as one joined string: the open and close
    // forms are located independently, so a tag may legitimately straddle the
    // boundary. The "\n" separator only blocks a spurious tag spliced together
    // from two fragments (a real tag is always contiguous within one body).
    const haystack = staticTexts.join("\n");
    for (const tag of requiredTags) {
      if (!hasOpenTag(haystack, tag) || !hasCloseTag(haystack, tag)) {
        errors.push({ code: ERR_OUTPUT_TAG_MISSING, path: tag });
      }
    }
  }
  return errors;
}
