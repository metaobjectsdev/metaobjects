// Selecting a field's view by the SURFACE that renders it (#356).
//
// A field may legally declare more than one `view.*` child and every one of them
// survives the load, so an emitter reading `field.views()[0]` let DECLARATION
// ORDER decide its output — and because several emitters read that same list,
// one declaration drove three unrelated surfaces at once. Declaring a
// `view.text` so a grid cell rendered as text silently degraded the generated
// FORM to an `<input>`, and swapping two lines of JSON with no semantic change
// flipped the form's `<select>` back. That is not a modelling mistake; it is the
// only possible outcome when one declaration serves three readers.
//
// The selector is the view's `name` — a reserved structural key already legal on
// every node — so this needs no new attribute, no provider and no
// `metamodelVersion` move (ADR-0037 step 0: the vocabulary existed, only the
// read was wrong). The same shape as #353's resolution.
//
// Two rules, and the second is the load-bearing one:
//
//   1. A field declaring ONE view keeps its exact current behaviour: that view
//      applies to every surface, whatever it is named (or unnamed). Existing
//      models are untouched by construction — a `name` is how a view is
//      ADDRESSED by `extends` (ADR-0029 `Customer.priceCents.display`), and
//      re-reading those names as surface names would break addressing.
//
//   2. A field declaring SEVERAL views must name one for the surface being
//      rendered. No match is a hard error, not a fallback: falling back to
//      `views()[0]` reinstates the positional read for exactly the multi-view
//      case this exists to fix, and falling back to the inferred default turns a
//      `name` typo ("forms") into a silently degraded control. A field cannot
//      declare two views with the SAME name — the loader merges same-(type,
//      name) siblings into one node — so a match is never ambiguous.

import type { MetaField, MetaView } from "@metaobjectsdev/metadata";
import { CodegenError } from "./errors.js";

/**
 * The surface a generated artifact renders, and therefore the `name` its
 * emitter looks for among a field's views.
 *
 * These are the only two surfaces the packaged generators render. An owned
 * generator (FR-040) targeting a third may pass its own name — `viewForContext`
 * takes any string — but it then owns telling its authors what to name.
 */
export const VIEW_CONTEXT_FORM = "form";
/** Both grid tiers (TanStack and Angular) render the same surface, so both ask for this. */
export const VIEW_CONTEXT_GRID = "grid";

/** Render `view.dropdown name="form"` / `view.text (no name)` for a diagnostic. */
function describe(view: MetaView): string {
  return view.name.length > 0
    ? `view.${view.subType} name="${view.name}"`
    : `view.${view.subType} (no name)`;
}

/** `Entity.field`, or just the field name when the field has no parent object. */
function fieldPath(field: MetaField): string {
  const owner = field.parent?.name;
  return owner !== undefined && owner.length > 0 ? `${owner}.${field.name}` : field.name;
}

/**
 * The view a field declares for `context`, or `undefined` when it declares none
 * at all (the caller's existing "no view" path — an inferred default — applies).
 *
 * Uses the RESOLVING accessor (ADR-0039): a view inherited through `extends` is
 * as much the field's view as one declared on it.
 *
 * @throws CodegenError when the field declares several views and none is named
 *   for `context`. The remedy is in the message: name one of them.
 */
export function viewForContext(field: MetaField, context: string): MetaView | undefined {
  const declared = field.views();
  // One view (or none) is unambiguous: it applies to every surface, exactly as
  // it did before this selector existed.
  if (declared.length <= 1) return declared[0];

  const match = declared.find((v) => v.name === context);
  if (match !== undefined) return match;

  throw new CodegenError(
    `Field "${fieldPath(field)}" declares ${declared.length} views ` +
      `(${declared.map(describe).join(", ")}) and none is named "${context}", so codegen ` +
      `cannot tell which one renders the ${context}. Name one of them "${context}" — a ` +
      `view's \`name\` selects the surface it renders ("${VIEW_CONTEXT_FORM}" or ` +
      `"${VIEW_CONTEXT_GRID}"). A field declaring a SINGLE view needs no name: that view ` +
      `applies to every surface.`,
  );
}
