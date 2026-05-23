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

/** A `{{var}}` references a field the (contextual) payload does not declare. */
export const ERR_VAR_NOT_ON_PAYLOAD = "ERR_VAR_NOT_ON_PAYLOAD";
/** A `{{> ref}}` partial does not resolve in the provider. */
export const ERR_PARTIAL_UNRESOLVED = "ERR_PARTIAL_UNRESOLVED";
/** A declared @requiredSlots slot is never referenced by the template (warning). */
export const ERR_REQUIRED_SLOT_UNUSED = "ERR_REQUIRED_SLOT_UNUSED";

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
}

const MAX_DEPTH = 32;

// A Mustache parse token: [type, value, start, end, subTokens?, ...].
type Token = readonly unknown[];
// The context stack — innermost context last, mirroring Mustache lookup order.
type Stack = readonly PayloadField[][];

function find(fields: PayloadField[], name: string): PayloadField | undefined {
  return fields.find((f) => f.name === name);
}

// Resolve a (possibly dotted) variable path the way Mustache does: the FIRST
// segment is looked up through the context stack (innermost → outermost); each
// remaining segment is a direct descent into the resolved field's `fields`.
// Returns the resolved field, or undefined if any segment is missing.
function resolve(stack: Stack, path: string): PayloadField | undefined {
  const segs = path.split(".");
  let current: PayloadField | undefined;
  for (let i = stack.length - 1; i >= 0; i--) {
    const hit = find(stack[i]!, segs[0]!);
    if (hit) {
      current = hit;
      break;
    }
  }
  for (let i = 1; current && i < segs.length; i++) {
    current = current.fields ? find(current.fields, segs[i]!) : undefined;
  }
  return current;
}

const parse = (text: string): Token[] => Mustache.parse(text) as unknown as Token[];

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

  function walk(tokens: Token[], stack: Stack, seen: readonly string[]): void {
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
          if (!resolve(stack, value)) errors.push({ code: ERR_VAR_NOT_ON_PAYLOAD, path: value });
          break;
        }
        case "#": // {{#x}}…{{/x}}
        case "^": {
          // {{^x}}…{{/x}}
          const sub = (Array.isArray(tok[4]) ? (tok[4] as Token[]) : []) as Token[];
          if (value === ".") {
            walk(sub, stack, seen);
            break;
          }
          if (atRoot) referencedAtRoot.add(value.split(".")[0]!);
          const field = resolve(stack, value);
          if (!field) {
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

  return errors;
}
