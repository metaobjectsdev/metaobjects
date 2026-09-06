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
// #356 — THE SURFACE IS THE FORM. `view` resolves through `inferViewKind(field, "form")`,
// which selects the view named for the form context, so a field declaring several views is
// described by the one the generated `<Entity>.form.tsx` actually renders. The grid tiers
// compute their own view kind at codegen time and never read this.
//
// RULES ARE AN ORDERED LIST, NOT A KEYED OBJECT, and that is load-bearing rather than
// stylistic: the emitted `rules: { ... }` object preserves the order the field's validator
// children were declared in, so a field whose `validator.regex` precedes its
// `validator.required` emits `pattern` first. A keyed shape would impose one fixed order
// and silently rewrite every such entity's descriptor.
//
// The pattern is carried RAW. Escaping it into a `/.../` literal is a TypeScript-emission
// concern and belongs to the emitter, not to the description of the field.

import type { MetaData, MetaField, MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
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
import { VIEW_CONTEXT_FORM } from "../view-context.js";
import { isProjection } from "../projection/projection-detector.js";
// `restPath` lives HERE rather than in api-surface.ts, which is where it used to sit and
// which now re-exports it. The descriptor is what emits `$path`, so the composition has to
// be reachable from this module; importing it back from `api-surface.js` would be a cycle,
// since that module imports `resourcePath` from this one. Neither of these two imports
// reaches back here, so moving the function down is the acyclic direction.
import { tphDiscriminatorBase, tphDiscriminatorPin } from "./zod-validators.js";
import { tphRouteSegment } from "./tph-discriminator.js";

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
  /** Present only when the view maps to a real HTML `<input type=…>`. Derived from the
   *  view subtype — there is no authored override (see `htmlTypeFromView`). */
  readonly htmlType?: string | undefined;
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
  /** The address the generated routes SERVE this object at — `/subscribers`, and
   *  `/vehicles/car` for a TPH subtype. Emitted as `$path`. See {@link restPath}. */
  readonly path: string;
  /** Every field, INHERITED INCLUDED (ADR-0039 resolving `fields()`). */
  readonly fields: readonly UiFieldDescriptor[];
}

/**
 * An object's OWN pluralized resource path — the one derivation of that spelling, and the
 * input {@link restPath} composes an address from. It is NOT `$path` on its own.
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
 * A TPH SUBTYPE is not addressed by this path — it is mounted under its base — so this is
 * an INPUT to {@link restPath}, not the answer. `$path` carries `restPath`; call this only
 * when you specifically want an object's own pluralized name, never to build an address.
 */
export function resourcePath(entity: MetaData): string {
  // The two compositions differ in ORDER as well as separator, and both are load-bearing:
  // pluralize-then-snake is what the projection const has always emitted, snake-then-
  // pluralize is what the entity const has. Neither may be "tidied" into the other.
  return isProjection(entity)
    ? `/${toSnakeCase(pluralize(entity.name)).replace(/_/g, "-")}`
    : `/${pluralize(toSnakeCase(entity.name))}`;
}

/**
 * THE address the generated routes serve this object at — and therefore what the
 * `<Entity>` const emits as `$path`.
 *
 * `resourcePath` answers a different question: an object's own pluralized name. The two
 * agree for everything EXCEPT a TPH subtype, which emits no routes file of its own —
 * `routes-file.ts` mounts the whole hierarchy from the discriminator BASE, giving the
 * union read-only routes at the base path and each subtype a full CRUD set at
 * `<base path>/<route segment>`.
 *
 * `$path` used to carry `resourcePath`, so a subtype's own `$path` named an endpoint that
 * did not exist. That was not confined to prose: `agent/ui.md` printed it as fact, and the
 * TanStack `grid-hook-file.ts` builds its fetch URL from `<Entity>.$path` with no TPH
 * branch at all, so an opted-in per-subtype grid requested an address nothing served.
 * Fixing it here fixes every consumer, because every consumer reads the const.
 *
 * The composition is the same one `routes-file.ts` and `hooks-file.ts` emit as CODE
 * (`Base.$path + "/car"`); they reference the const rather than a computed string, so this
 * is the one place it can be evaluated. The SEGMENT rule is not restated —
 * `tphRouteSegment` owns it, and all three read it from there.
 */
export function restPath(entity: MetaObject): string {
  const pin = tphDiscriminatorPin(entity);
  const base = tphDiscriminatorBase(entity);
  if (pin === undefined || base === undefined) return resourcePath(entity);
  return `${resourcePath(base)}/${tphRouteSegment(pin.value)}`;
}

/**
 * Map a MetaView subtype to a real HTML `<input type=…>` value. Returns undefined for
 * views that don't map to `<input>` at all (textarea, dropdown) — consumers render the
 * right element type themselves.
 *
 * THE MAPPING IS THE ONLY SOURCE. An `@htmlType` override used to be read off the view
 * node ahead of this switch; nothing registers that attribute, so the override was
 * unreachable and this mapping was always the answer. A consumer needing a different
 * `type=` edits the emitted `<Entity>.meta.ts`, whose hand edits the merge preserves.
 */
function htmlTypeFromView(view: string): string | undefined {
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

  // ADR-0039: resolving — a validator may inherit its config attrs (@min/@max/@pattern)
  // via extends.
  //
  // THE MESSAGES ARE DERIVED, NOT AUTHORED. `@message` / `@minMessage` / `@maxMessage`
  // used to be read here as overrides; no provider registers any of them, so the reads
  // were unreachable and the defaults below were always what shipped. A consumer wanting
  // different wording edits the emitted `rules` object in `<Entity>.meta.ts`, which is a
  // generated file whose hand edits the three-way merge preserves. See ADR-0023.
  for (const child of field.validators()) {
    if (child.subType === VALIDATOR_SUBTYPE_REQUIRED) {
      rules.push({ kind: "required", message: `${humanize(field.name)} is required` });
      hasRequired = true;
    } else if (child.subType === VALIDATOR_SUBTYPE_LENGTH) {
      const min = child.attr(VALIDATOR_ATTR_MIN);
      const max = child.attr(VALIDATOR_ATTR_MAX);
      if (typeof min === "number") {
        rules.push({ kind: "minLength", value: min, message: `Must be at least ${min} characters` });
      }
      if (typeof max === "number") {
        rules.push({ kind: "maxLength", value: max, message: `Must be ${max} characters or fewer` });
        hasMaxLength = true;
      }
    } else if (child.subType === VALIDATOR_SUBTYPE_REGEX) {
      const pattern = child.attr(VALIDATOR_ATTR_PATTERN);
      if (typeof pattern === "string") {
        rules.push({ kind: "pattern", pattern, message: "Invalid format" });
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
  // `inferViewKind` IS the resolution: the view child declared for the FORM (own or
  // inherited) wins, else the field subtype's default. This module used to keep a
  // `resolveView` that returned the same string plus the view NODE, and the node existed
  // only to read `@placeholder` / `@helpText` / `@htmlType` off it — none of which any
  // provider registers, so all three reads were unreachable. With them gone the node has
  // no reader and the two functions were the same function.
  const view = inferViewKind(field, VIEW_CONTEXT_FORM);
  const currencyMeta = currencyMetaFor(field, VIEW_CONTEXT_FORM);
  const vo = root === undefined ? undefined : valueObjectFor(field, root);
  return {
    name: field.name,
    label: labelFor(field, VIEW_CONTEXT_FORM),
    view,
    htmlType: htmlTypeFromView(view),
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
    // `restPath`, not `resourcePath`: `$path` is the address this object is SERVED at.
    // They differ only for a TPH subtype, and for that one case `resourcePath` names an
    // endpoint nothing mounts (see restPath's note).
    path: restPath(obj),
    // ADR-0039: resolving `fields()` so inherited fields appear, exactly as the emitted
    // descriptor has always done.
    fields: obj.fields().map((f) => buildUiFieldDescriptor(f, root)),
  };
}
