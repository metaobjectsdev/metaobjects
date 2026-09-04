// The per-field FORM descriptor — the one derivation of "what does this field look like
// in a UI", shared by everything that answers that question.
//
// Two consumers, and the reason they must share:
//
//   • `renderEntityConstants()` emits it as the `<Entity>` const in `<Entity>.meta.ts`,
//     which `useEntityForm` reads at RUNTIME to render the form;
//   • the `agent/ui.md` docs surface renders it as a table, which is what an agent reads
//     BEFORE it writes code against that form.
//
// If those two were derived separately, the page describing the form and the descriptor
// driving it could disagree — and the disagreement would be invisible, because the page
// looks authoritative and nothing compares them. That is the same "a name resolved twice
// is a name that can disagree with itself" rule `names.ts` states for physical names, one
// tier up.
//
// #356 — THE SURFACE IS THE FORM. `view` resolves through `viewForContext(field, "form")`,
// so a field declaring several views is described by the one the generated
// `<Entity>.form.tsx` actually renders. The grid tiers compute their own view kind at
// codegen time and never read this.
//
// RULES ARE AN ORDERED LIST, NOT A KEYED OBJECT, and that is load-bearing rather than
// stylistic: the emitted `rules: { ... }` object preserves the order the field's validator
// children were declared in, so a field whose `validator.regex` precedes its
// `validator.required` emits `pattern` first. A keyed shape would impose one fixed order
// and silently rewrite every such entity's descriptor.
//
// The pattern is carried RAW. Escaping it into a `/.../` literal is a TypeScript-emission
// concern and belongs to the emitter, not to the description of the field.

import type { MetaData, MetaField, MetaObject, MetaView } from "@metaobjectsdev/metadata";
import {
  VIEW_SUBTYPE_TEXT,
  VIEW_SUBTYPE_TEXTAREA,
  VIEW_SUBTYPE_NUMBER,
  VIEW_SUBTYPE_CHECKBOX,
  VIEW_SUBTYPE_DATE,
  VIEW_SUBTYPE_PASSWORD,
  VIEW_SUBTYPE_HIDDEN,
  VIEW_SUBTYPE_DROPDOWN,
  VIEW_SUBTYPE_RADIO,
  VALIDATOR_SUBTYPE_REQUIRED,
  VALIDATOR_SUBTYPE_LENGTH,
  VALIDATOR_SUBTYPE_REGEX,
  VALIDATOR_ATTR_MIN,
  VALIDATOR_ATTR_MAX,
  VALIDATOR_ATTR_PATTERN,
  FIELD_ATTR_MAX_LENGTH,
  FIELD_ATTR_REQUIRED,
  pluralize,
  toSnakeCase,
} from "@metaobjectsdev/metadata";
import { inferViewKind, currencyMetaFor, labelFor } from "./field-meta.js";
import { viewForContext, VIEW_CONTEXT_FORM } from "../view-context.js";

/** One validation rule, in the order its source was declared. */
export type UiRule =
  | { readonly kind: "required"; readonly message: string }
  | { readonly kind: "minLength"; readonly value: number; readonly message: string }
  | { readonly kind: "maxLength"; readonly value: number; readonly message: string }
  /** `pattern` is the RAW authored regex source — never pre-escaped. */
  | { readonly kind: "pattern"; readonly pattern: string; readonly message: string };

export interface UiFieldDescriptor {
  readonly name: string;
  readonly label: string;
  /** The MetaView subtype resolved for the FORM context. */
  readonly view: string;
  /** Present only when the view maps to a real HTML `<input type=…>`. */
  readonly htmlType?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly helpText?: string | undefined;
  /** Empty when the field declares nothing to validate. */
  readonly rules: readonly UiRule[];
  /** Present only for a `field.currency`. */
  readonly currency?: { readonly currency: string; readonly locale: string } | undefined;
}

export interface EntityUiDescriptor {
  readonly entity: string;
  /** REST resource path — `/subscribers`. */
  readonly path: string;
  /** Every field, INHERITED INCLUDED (ADR-0039 resolving `fields()`). */
  readonly fields: readonly UiFieldDescriptor[];
}

/** Convert a camelCase or PascalCase field name to a human-friendly label. */
export function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .trim();
}

/**
 * REST resource path for an entity. Pluralized + snake_cased + lowercased.
 *   "Subscriber" → "/subscribers"
 *   "WorkoutEvent" → "/workout_events"
 */
export function resourcePath(entity: MetaData): string {
  // ADR-0039: resolving — a concrete entity may inherit @routePath via extends.
  const overrideAttr = entity.attr("routePath");
  if (typeof overrideAttr === "string" && overrideAttr.length > 0) {
    return overrideAttr.startsWith("/") ? overrideAttr : `/${overrideAttr}`;
  }
  return `/${pluralize(toSnakeCase(entity.name))}`;
}

/**
 * Resolve the view subtype: the explicit `view` child declared for the FORM (own
 * or inherited) wins, else inferred from field subType.
 */
function resolveView(field: MetaField): { view: string; viewNode?: MetaView } {
  const viewNode = viewForContext(field, VIEW_CONTEXT_FORM);
  if (viewNode !== undefined) {
    return { view: viewNode.subType, viewNode };
  }
  return { view: inferViewKind(field, VIEW_CONTEXT_FORM) };
}

/**
 * Map a MetaView subtype to a real HTML `<input type=…>` value. Returns undefined for
 * views that don't map to `<input>` at all (textarea, dropdown) — consumers render the
 * right element type themselves.
 */
function htmlTypeFromView(view: string, override?: string): string | undefined {
  if (typeof override === "string" && override.length > 0) return override;
  switch (view) {
    case VIEW_SUBTYPE_TEXT:
      return "text";
    case VIEW_SUBTYPE_NUMBER:
      return "number";
    case VIEW_SUBTYPE_DATE:
      return "date";
    case VIEW_SUBTYPE_PASSWORD:
      return "password";
    case VIEW_SUBTYPE_CHECKBOX:
      return "checkbox";
    case VIEW_SUBTYPE_HIDDEN:
      return "hidden";
    case VIEW_SUBTYPE_RADIO:
      return "radio";
    case "month":
      return "month";
    case "email":
      return "email";
    case VIEW_SUBTYPE_TEXTAREA:
    case VIEW_SUBTYPE_DROPDOWN:
      return undefined;
    default:
      return undefined;
  }
}

/**
 * The field's validation rules, in DECLARATION ORDER — see the ordering note at the top
 * of this file.
 *
 * The field-level `@required` / `@maxLength` attrs append only when no validator child
 * already supplied that rule, so the two authoring spellings never double up.
 */
function buildFieldRules(field: MetaField): UiRule[] {
  const rules: UiRule[] = [];
  let hasRequired = false;
  let hasMaxLength = false;

  // ADR-0039: resolving — a validator may inherit its config attrs (@min/@max/
  // @pattern/@message/…) via extends.
  for (const child of field.validators()) {
    if (child.subType === VALIDATOR_SUBTYPE_REQUIRED) {
      const message =
        (child.attr("message") as string | undefined) ?? `${humanize(field.name)} is required`;
      rules.push({ kind: "required", message });
      hasRequired = true;
    } else if (child.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const min = child.attr(VALIDATOR_ATTR_MIN);
      const max = child.attr(VALIDATOR_ATTR_MAX);
      if (typeof min === "number") {
        const message =
          (child.attr("minMessage") as string | undefined) ?? `Must be at least ${min} characters`;
        rules.push({ kind: "minLength", value: min, message });
      }
      if (typeof max === "number") {
        const message =
          (child.attr("maxMessage") as string | undefined) ?? `Must be ${max} characters or fewer`;
        rules.push({ kind: "maxLength", value: max, message });
        hasMaxLength = true;
      }
    } else if (child.subType === VALIDATOR_SUBTYPE_REGEX) {
      const pattern = child.attr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern === "string") {
        const message = (child.attr("message") as string | undefined) ?? "Invalid format";
        rules.push({ kind: "pattern", pattern, message });
      }
    }
  }

  // Field-level @required attr (if not already covered by validator).
  if (!hasRequired && field.attr(FIELD_ATTR_REQUIRED) === true) {
    rules.push({ kind: "required", message: `${humanize(field.name)} is required` });
  }

  // Field-level @maxLength attr (if not already covered).
  const maxLenAttr = field.attr(FIELD_ATTR_MAX_LENGTH);
  if (!hasMaxLength && typeof maxLenAttr === "number") {
    rules.push({
      kind: "maxLength",
      value: maxLenAttr,
      message: `Must be ${maxLenAttr} characters or fewer`,
    });
  }

  return rules;
}

/** Describe one field's form presentation. */
export function buildUiFieldDescriptor(field: MetaField): UiFieldDescriptor {
  const { view, viewNode } = resolveView(field);
  // ADR-0039: resolving — a view node may inherit @placeholder/@helpText/@htmlType via extends.
  const placeholder = viewNode?.attr("placeholder") as string | undefined;
  const helpText = viewNode?.attr("helpText") as string | undefined;
  const htmlType = htmlTypeFromView(view, viewNode?.attr("htmlType") as string | undefined);
  const currencyMeta = currencyMetaFor(field, VIEW_CONTEXT_FORM);
  return {
    name: field.name,
    label: labelFor(field, VIEW_CONTEXT_FORM),
    view,
    htmlType,
    placeholder,
    helpText,
    rules: buildFieldRules(field),
    currency: currencyMeta === null
      ? undefined
      : { currency: currencyMeta.currency, locale: currencyMeta.locale },
  };
}

/** Describe one object's whole form surface. */
export function buildEntityUiDescriptor(obj: MetaObject): EntityUiDescriptor {
  return {
    entity: obj.name,
    path: resourcePath(obj),
    // ADR-0039: resolving `fields()` so inherited fields appear, exactly as the emitted
    // descriptor has always done.
    fields: obj.fields().map(buildUiFieldDescriptor),
  };
}
