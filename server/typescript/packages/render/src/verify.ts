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
import { HAS_PREFIX, LAST_ACCESSOR, hasAccessorName } from "./payload-accessors.js";
import { TEMPLATE_ENGINE_JINJA, TEMPLATE_ENGINE_MUSTACHE, partialEngineMismatch } from "./engine.js";
import { verifyJinja } from "./jinja/verify.js";
import {
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_TEMPLATE_ENGINE_UNSUPPORTED,
  ERR_TEMPLATE_SYNTAX,
  MAX_DEPTH,
  slotAndTagFindings,
  type PayloadField,
  type VerifyError,
  type VerifyOptions,
} from "./verify-shared.js";

export {
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_REQUIRED_SLOT_UNUSED,
  ERR_OUTPUT_TAG_MISSING,
  ERR_TEMPLATE_NOT_STATIC,
  ERR_TEMPLATE_SYNTAX,
  ERR_TEMPLATE_ENGINE_UNSUPPORTED,
  type PayloadField,
  type VerifyError,
  type VerifyOptions,
} from "./verify-shared.js";

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

/**
 * True when `name` is the positional accessor `-last` and it is available in the current scope.
 * `positional` is true exactly when the innermost enclosing ARRAY section iterates object
 * elements — the engine puts `-last` on each of those (payload-accessors.ts). An array of
 * scalars makes it unavailable even inside an outer object list: a scalar element carries no
 * key, so the lookup would bind to the OUTER element's position and render wrong.
 */
function isPositionalAccessor(positional: boolean, name: string): boolean {
  return positional && name === LAST_ACCESSOR;
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

/** Parse `text`; a Mustache syntax error becomes an ERR_TEMPLATE_SYNTAX finding, anything else rethrows. */
function parseOrSyntaxError(text: string): Token[] | VerifyError {
  try {
    return parse(text);
  } catch (e) {
    const section = syntaxSection(e);
    if (section === undefined) throw e;
    return { code: ERR_TEMPLATE_SYNTAX, path: section };
  }
}

const TOKEN_PARTIAL = ">";
const TOKEN_COMMENT = "!";
const TOKEN_DELIMITERS = "=";

/** Every token in a parse, depth-first, section bodies included. */
function flatTokens(tokens: readonly Token[]): Token[] {
  const out: Token[] = [];
  for (const tok of tokens) {
    out.push(tok);
    if (Array.isArray(tok[4])) out.push(...flatTokens(tok[4] as Token[]));
  }
  return out;
}

/** Every partial tag in a parse, in text order, as `[ref, start, end]` (nested sections included). */
export function partialTokens(tokens: readonly Token[]): [string, number, number][] {
  return flatTokens(tokens)
    .filter((tok) => tok[0] === TOKEN_PARTIAL)
    .map((tok) => [tok[1] as string, tok[2] as number, tok[3] as number]);
}

/** Whether the parse contains a `{{=<% %>=}}` delimiter change. */
export function hasDelimiterChange(tokens: readonly Token[]): boolean {
  return flatTokens(tokens).some((tok) => tok[0] === TOKEN_DELIMITERS);
}

/** A text that changes delimiters and also uses a partial does not render: the inlined partial
 *  would be parsed under the changed delimiters. Reported against the text's first partial. */
function delimiterConflict(tokens: readonly Token[]): VerifyError | undefined {
  const first = partialTokens(tokens)[0];
  return first !== undefined && hasDelimiterChange(tokens) ? { code: ERR_TEMPLATE_SYNTAX, path: first[0] } : undefined;
}

function commentSpans(tokens: readonly Token[]): [number, number][] {
  return flatTokens(tokens)
    .filter((tok) => tok[0] === TOKEN_COMMENT)
    .map((tok) => [tok[2] as number, tok[3] as number]);
}

/** `text` with its comments cut out: what a tag-presence check may scan. */
function withoutComments(text: string, tokens: readonly Token[]): string {
  let out = "";
  let pos = 0;
  for (const [start, end] of commentSpans(tokens)) {
    out += text.slice(pos, start);
    pos = end;
  }
  return out + text.slice(pos);
}

/** The section a Mustache parse error is about (`Unopened section "x" at 4`), else undefined. */
function syntaxSection(e: unknown): string | undefined {
  const m = /^(?:Unopened|Unclosed) section "(.*)" at \d+$/.exec(e instanceof Error ? e.message : "");
  return m?.[1];
}

/**
 * Parse a template into Mustache tokens (`[type, value, start, end, subTokens?]`),
 * the SAME parse verify walks. Exported so the docs annotator tokenizes through
 * one parser (no divergent re-tokenization). Returns a readonly token list.
 */
export function parseTemplate(text: string): readonly (readonly unknown[])[] {
  return parse(text);
}

/**
 * Check a template's references against a payload field tree, returning a list of
 * drift errors. Mustache by default; `opts.engine: "jinja"` walks the Jinja AST
 * instead (jinja/verify.ts) and reports the same codes.
 *
 * Mustache is context-sensitive: a section `{{#posts}}…{{/posts}}` over a
 * container field checks its body against that field's element type.
 */
export function verify(
  templateText: string,
  fields: PayloadField[],
  opts?: VerifyOptions,
): VerifyError[] {
  if (opts?.engine === TEMPLATE_ENGINE_JINJA) return verifyJinja(templateText, fields, opts);
  const errors: VerifyError[] = [];
  const provider = opts?.provider;
  const root = fields;
  const referencedAtRoot = new Set<string>();
  // The static text the output-tag check scans: the body plus every
  // provider-resolved partial body, collected during the single walk below
  // (no second resolution pass).
  const staticTexts: string[] = [templateText];

  function walk(tokens: Token[], stack: ResolveStack, seen: readonly string[], positional = false): void {
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
          if (!resolve(stack, value) && !isBooleanAccessor(stack, value) && !isPositionalAccessor(positional, value))
            errors.push({ code: ERR_VAR_NOT_ON_PAYLOAD, path: value });
          break;
        }
        case "#": // {{#x}}…{{/x}}
        case "^": {
          // {{^x}}…{{/x}}
          const sub = Array.isArray(tok[4]) ? (tok[4] as Token[]) : [];
          if (value === ".") {
            walk(sub, stack, seen, positional);
            break;
          }
          if (atRoot) referencedAtRoot.add(value.split(".")[0]!);
          const field = resolve(stack, value);
          if (!field) {
            // A positional `-last` gate is a BOOLEAN on the current element: it pushes
            // nothing, so the body walks in the SAME scope.
            if (isPositionalAccessor(positional, value)) {
              walk(sub, stack, seen, positional);
              break;
            }
            // A derived `has<Field>` gate is a BOOLEAN over the current context, so it
            // resolves nothing and pushes nothing — walk the body in the SAME scope,
            // which is what `{{#hasAbilities}}{{#abilities}}…` depends on.
            if (isBooleanAccessor(stack, value)) {
              walk(sub, stack, seen, positional);
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
          // Only a `#` over an ARRAY iterates, so only it moves the positional scope: object
          // elements carry `-last`, scalar elements do not. A section over a non-array field
          // (a scalar conditional, a single nested object) and every `^` section are
          // transparent — the enclosing element's position is still the one in reach.
          const iterates = type === "#" && field.isArray === true;
          walk(sub, push ? [...stack, field.fields!] : stack, seen, iterates ? field.fields !== undefined : positional);
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
          if (partialEngineMismatch(provider, value, TEMPLATE_ENGINE_MUSTACHE)) {
            errors.push({ code: ERR_TEMPLATE_ENGINE_UNSUPPORTED, path: value });
            break;
          }
          const parsed = parseOrSyntaxError(text);
          if (!Array.isArray(parsed)) {
            errors.push(parsed);
            break;
          }
          const conflict = delimiterConflict(parsed);
          if (conflict) errors.push(conflict);
          staticTexts.push(withoutComments(text, parsed));
          walk(parsed, stack, [...seen, value], positional);
          break;
        }
        default:
          break; // text / comment / set-delimiter
      }
    }
  }

  const bodyTokens = parseOrSyntaxError(templateText);
  if (!Array.isArray(bodyTokens)) return [bodyTokens];
  const conflict = delimiterConflict(bodyTokens);
  if (conflict) errors.push(conflict);
  staticTexts[0] = withoutComments(templateText, bodyTokens);
  walk(bodyTokens, [root], []);

  errors.push(...slotAndTagFindings(referencedAtRoot, staticTexts, opts));
  return errors;
}
