// Template-side drift check (FR-004 Plan #3, T5). The other half of the
// guarantee: Phase B types the payload at the CALL SITE (compile-time), while
// `verify` parses the opaque template TEXT and cross-checks every variable
// against the payload's declared field tree (build-time). A Mustache template
// is a runtime string the TS compiler can't see into, so this is the only way
// to catch "a renamed field silently broke a prompt".
//
// Zero core dependency by design: `verify` takes a PLAIN field tree (no
// metadata import). The CLI derives that tree from the loaded object.value and
// passes it in — keeping this engine a standalone, byte-portable module.

import Mustache from "mustache";
import type { Provider } from "./provider.js";
import { HAS_PREFIX, hasAccessorName } from "./payload-accessors.js";

/** A `{{var}}` references a field the (contextual) payload does not declare. */
export const ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD";
/** A `{{> ref}}` partial does not resolve in the provider. */
export const ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED";
/** A declared @requiredSlots slot is never referenced by the template (warning). */
export const ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED";
/** A declared @requiredTags output tag is absent from the template text. */
export const ERR_OUTPUT_TAG_MISSING = "ERR_OUTPUT_TAG_MISSING";

/**
 * A plain field-tree node mirroring an `object.value` view-object's field walk.
 * `fields` present → a context-pushing field (object / array-of-object); absent
 * → a scalar (string/number/boolean/scalar-array).
 */
export interface PayloadField {
  name: string;
  fields?: PayloadField[];
}

export interface VerifyError {
  code: string;
  /** The offending variable path, partial ref, or slot name. */
  path: string;
}

export interface VerifyOptions {
  /** When given, `{{> ref}}` partials are resolved + their bodies recursed. */
  provider?: Provider;
  /** Slots that MUST be referenced; an unused one is reported as a warning. */
  requiredSlots?: string[];
  /**
   * Output tags the rendered text is contracted to contain. Each must appear as
   * both an opening form (`<tag` followed by `>` or whitespace, so attributes are
   * allowed) and a closing `</tag>` — across the body AND resolved partials.
   */
  requiredTags?: string[];
}

const MAX_DEPTH = 32;

// A Mustache parse token: [type, value, start, end, subTokens?, ...].
type Token = readonly unknown[];
/**
 * The context stack — innermost context last, mirroring Mustache lookup order.
 * Generic over the field node so consumers (e.g. the docs annotator) can resolve
 * an ENRICHED field tree (carrying owner/type metadata) through the EXACT same
 * walk verify uses, guaranteeing the two surfaces agree.
 */
export type ResolveStack<F extends PayloadField = PayloadField> = readonly F[][];

/**
 * True when `name` is a derived boolean accessor (`has<Field>`) over a field
 * reachable on the current context stack — the same rule the payload emitter uses
 * (payload-accessors.ts), so an accepted section and an emitted accessor can never
 * drift apart. A `{{#hasX}}` with no field `x` on any scope is NOT an accessor and
 * stays ERR_VAR_NOT_ON_PAYLOAD drift.
 *
 * Accessors are simple (undotted) names; a dotted path is never an accessor and is
 * left to normal field resolution. Byte-identical to the JVM's
 * `Verify.isBooleanAccessor`, including its deliberate permissiveness: acceptance
 * keys off the FIELD EXISTING, not off its type.
 */
function isBooleanAccessor<F extends PayloadField>(stack: ResolveStack<F>, name: string): boolean {
  if (name.includes(".")) return false;
  if (!name.startsWith(HAS_PREFIX)) return false;
  for (let i = stack.length - 1; i >= 0; i--) {
    for (const f of stack[i]!) if (name === hasAccessorName(f.name)) return true;
  }
  return false;
}

function find<F extends PayloadField>(fields: F[], name: string): F | undefined {
  return fields.find((f) => f.name === name);
}

/**
 * Resolve a (possibly dotted) variable path the way Mustache does: the FIRST
 * segment is looked up through the context stack (innermost → outermost); each
 * remaining segment is a direct descent into the resolved field's `fields`.
 * Returns the resolved field, or undefined if any segment is missing.
 *
 * EXPORTED so the docs annotator can share this ONE resolution (annotator ⇆
 * verify must agree). Generic over the node type: an enriched tree resolves the
 * same way, since only `name`/`fields` drive the walk.
 */
export function resolveTemplateVariable<F extends PayloadField>(
  stack: ResolveStack<F>,
  path: string,
): F | undefined {
  const segs = path.split(".");
  let current: F | undefined;
  for (let i = stack.length - 1; i >= 0; i--) {
    const hit = find(stack[i]!, segs[0]!);
    if (hit) {
      current = hit;
      break;
    }
  }
  for (let i = 1; current && i < segs.length; i++) {
    current = current.fields ? (find(current.fields, segs[i]!) as F | undefined) : undefined;
  }
  return current;
}

// Internal alias preserving the original call sites unchanged.
const resolve = resolveTemplateVariable;

function parse(text: string): Token[] {
  return Mustache.parse(text) as unknown as Token[];
}

/**
 * Parse a template into Mustache tokens (`[type, value, start, end, subTokens?]`),
 * the SAME parse verify walks. Exported so the docs annotator tokenizes through
 * one parser (no divergent re-tokenization). Returns a readonly token list.
 */
export function parseTemplate(text: string): readonly (readonly unknown[])[] {
  return parse(text);
}

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
 * Walk a Mustache template's tokens against a payload field tree, returning a
 * list of drift errors. Context-sensitive: a section `{{#posts}}…{{/posts}}`
 * over a container field checks its body against that field's element type.
 */
export function verify(
  templateText: string,
  fields: PayloadField[],
  opts?: VerifyOptions,
): VerifyError[] {
  const errors: VerifyError[] = [];
  const provider = opts?.provider;
  const root = fields;
  const referencedAtRoot = new Set<string>();
  // The static text the output-tag check scans: the body plus every
  // provider-resolved partial body, collected during the single walk below
  // (no second resolution pass).
  const staticTexts: string[] = [templateText];

  function walk(tokens: Token[], stack: ResolveStack, seen: readonly string[]): void {
    const atRoot = stack.length === 1 && stack[0] === root;
    for (const tok of tokens) {
      const type = tok[0] as string;
      const value = tok[1] as string;
      switch (type) {
        case "name": // {{x}}
        case "&": // {{&x}}
        case "{": {
          // {{{x}}} (spec); mustache.js emits "&" for it too
          if (value === ".") break; // implicit iterator — always valid
          if (atRoot) referencedAtRoot.add(value.split(".")[0]!);
          if (!resolve(stack, value) && !isBooleanAccessor(stack, value))
            errors.push({ code: ERR_VAR_NOT_ON_PAYLOAD, path: value });
          break;
        }
        case "#": // {{#x}}…{{/x}}
        case "^": {
          // {{^x}}…{{/x}}
          const sub = Array.isArray(tok[4]) ? (tok[4] as Token[]) : [];
          if (value === ".") {
            walk(sub, stack, seen);
            break;
          }
          if (atRoot) referencedAtRoot.add(value.split(".")[0]!);
          const field = resolve(stack, value);
          if (!field) {
            // A derived `has<Field>` gate is a BOOLEAN over the current context, so it
            // resolves nothing and pushes nothing — walk the body in the SAME scope,
            // which is what `{{#hasAbilities}}{{#abilities}}…` depends on.
            if (isBooleanAccessor(stack, value)) {
              walk(sub, stack, seen);
              break;
            }
            // Unresolved section head is itself drift; skip the body (its
            // context is unknowable, walking it would cascade false errors).
            errors.push({ code: ERR_VAR_NOT_ON_PAYLOAD, path: value });
            break;
          }
          // `#` over a container pushes its element fields; `^` (and `#` over a
          // scalar, used as a conditional) keep the current context.
          const push = type === "#" && field.fields !== undefined;
          walk(sub, push ? [...stack, field.fields!] : stack, seen);
          break;
        }
        case ">": {
          // {{> group/source}}
          if (!provider) break; // can't resolve without a provider
          if (seen.includes(value) || seen.length >= MAX_DEPTH) break; // cycle/depth guard
          const text = provider.resolve(value);
          if (text === undefined) {
            errors.push({ code: ERR_PARTIAL_UNRESOLVED, path: value });
            break;
          }
          staticTexts.push(text);
          walk(parse(text), stack, [...seen, value]);
          break;
        }
        default:
          break; // text / comment / set-delimiter
      }
    }
  }

  walk(parse(templateText), [root], []);

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
