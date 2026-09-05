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

import type { MetaData, MetaField, MetaObject, MetaRoot, MetaView } from "@metaobjectsdev/metadata";
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
import { inferViewKind, currencyMetaFor, labelFor, humanize, valueObjectFor } from "./field-meta.js";
import { viewForContext, VIEW_CONTEXT_FORM } from "../view-context.js";
import { isProjection } from "../projection/projection-detector.js";

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
  /**
   * Present when the generated FORM renders this field as a nested value-object
   * sub-form rather than an input — a `field.object` whose `@objectRef` resolves (see
   * `valueObjectFor`). Computed only when `buildEntityUiDescriptor` is given the loaded
   * root; `renderEntityConstants` does not pass one and emits nothing for it, so the
   * `<Entity>` const is byte-identical either way.
   */
  readonly nested?: { readonly objectRef: string; readonly isArray: boolean } | undefined;
}

export interface EntityUiDescriptor {
  readonly entity: string;
  /** REST resource path — `/subscribers`. */
  readonly path: string;
  /** Every field, INHERITED INCLUDED (ADR-0039 resolving `fields()`). */
  readonly fields: readonly UiFieldDescriptor[];
}

/**
 * THE REST resource path for an object — the one derivation of `$path`.
 *
 * A projection is KEBAB-cased and an entity is SNAKE-cased, and that split is not a
 * style choice: both spellings are already mounted. `renderProjectionDecl` emits
 * `$path: "/order-summaries"` and `renderEntityConstants` emits `$path:
 * "/order_summaries"`, and `routes-file.ts` mounts whichever const belongs to the object
 * — so an address computed without the split is wrong for every multi-word projection.
 * It used to live in a second function inside `projection-decl.ts`, which is exactly how
 * `agent/ui.md` and `api/AGENT-API.md` both came to print `/order_summaries` for a
 * projection served at `/order-summaries`.
 *
 *   "Subscriber"     → "/subscribers"
 *   "WorkoutEvent"   → "/workout_events"
 *   "ProgramSummary" → "/program-summaries"   (projection)
 *
 * A TPH SUBTYPE is not addressed by this path — it is mounted under its base — so use
 * {@link restPath} for the endpoint an object is actually served at.
 */
export function resourcePath(entity: MetaData): string {
  // ADR-0039: resolving — a concrete entity may inherit @routePath via extends.
  //
  // ADR-0023 PROVENANCE: `routePath` is registered by NO provider in this repository,
  // so this branch is unreachable for any project loading the shipped registry (an
  // authored `@routePath` fails the load with ERR_UNKNOWN_ATTR). It is kept because a
  // project may register it in a provider of its own, and because removing it would
  // silently move an endpoint for one that has. It is NOT core vocabulary; see the
  // `agent/ui.md` note that says so on the page.
  const overrideAttr = entity.attr("routePath");
  if (typeof overrideAttr === "string" && overrideAttr.length > 0) {
    return overrideAttr.startsWith("/") ? overrideAttr : `/${overrideAttr}`;
  }
  // The two compositions differ in ORDER as well as separator, and both are load-bearing:
  // pluralize-then-snake is what the projection const has always emitted, snake-then-
  // pluralize is what the entity const has. Neither may be "tidied" into the other.
  return isProjection(entity)
    ? `/${toSnakeCase(pluralize(entity.name)).replace(/_/g, "-")}`
    : `/${pluralize(toSnakeCase(entity.name))}`;
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
  //
  // ADR-0023 PROVENANCE: `message`, `minMessage` and `maxMessage` are registered by no
  // provider in this repository, so every `??` below always takes its default branch for a
  // project loading the shipped registry. Kept rather than deleted for the same reason as
  // `placeholder`/`helpText` above — the emitted `rules` object is a published consumer
  // surface — and `agent/ui.md` prints the rule's VALUE, never its message, so no page
  // claims a custom one exists.
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

/**
 * Describe one field's form presentation.
 *
 * `root` is OPTIONAL and only decides whether `nested` is filled in: resolving a
 * `field.object`'s `@objectRef` needs the run's other objects, and the two callers differ
 * — `renderEntityConstants` has no root (it is also ejected into adopter repos with a
 * fixed signature) while the docs surface does. Passing one adds a member the const
 * emitter ignores; it never changes any member the const emits.
 */
export function buildUiFieldDescriptor(field: MetaField, root?: MetaRoot): UiFieldDescriptor {
  const { view, viewNode } = resolveView(field);
  // ADR-0039: resolving — a view node may inherit @placeholder/@helpText/@htmlType via extends.
  //
  // ADR-0023 PROVENANCE: none of `placeholder`, `helpText` or `htmlType` is registered by
  // any provider in this repository, so all three branches are unreachable for a project
  // loading the shipped registry — the same shape #353 found and fixed for `@label` by
  // re-pointing it at the registered `@title`. There is no registered equivalent for
  // these three, and `EntityFieldMeta` (the public `@metaobjectsdev/react` type) declares
  // all three, so they are kept for a project that registers them in its own provider
  // rather than deleted. They are NOT core vocabulary, and `agent/ui.md` says so.
  const placeholder = viewNode?.attr("placeholder") as string | undefined;
  const helpText = viewNode?.attr("helpText") as string | undefined;
  const htmlType = htmlTypeFromView(view, viewNode?.attr("htmlType") as string | undefined);
  const currencyMeta = currencyMetaFor(field, VIEW_CONTEXT_FORM);
  const vo = root === undefined ? undefined : valueObjectFor(field, root);
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
    nested: vo === undefined
      ? undefined
      : { objectRef: vo.name, isArray: field.resolvedIsArray() },
  };
}

/** Describe one object's whole form surface. See {@link buildUiFieldDescriptor} for `root`. */
export function buildEntityUiDescriptor(obj: MetaObject, root?: MetaRoot): EntityUiDescriptor {
  return {
    entity: obj.name,
    path: resourcePath(obj),
    // ADR-0039: resolving `fields()` so inherited fields appear, exactly as the emitted
    // descriptor has always done.
    fields: obj.fields().map((f) => buildUiFieldDescriptor(f, root)),
  };
}
