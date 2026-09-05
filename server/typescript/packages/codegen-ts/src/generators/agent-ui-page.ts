// `agent/ui.md` — the generated UI surface, for an agent about to touch a form or a grid.
//
// The gap this closes is narrow and real: the neutral model entity page renders NO
// `view.*` or `layout.*` metadata at all, so an agent asked to change a form had nowhere
// to learn what the form already is and would read the generated TSX — the disposable
// artifact — as if it were the source.
//
// EVERY FIELD ROW COMES FROM `buildEntityUiDescriptor`, the same derivation
// `renderEntityConstants` emits as the `<Entity>` const in `<Entity>.meta.ts`, which is
// what `useEntityForm` reads at runtime. One derivation, two renderings: the page cannot
// describe a control the form does not render, because both answers come from the same
// call. That is the point of the descriptor extraction, not a nicety.
//
// The three columns the descriptor does NOT carry — `@formExclude`, `@filterable` and
// `@sortable` — are read here from the field, and `@sortable`'s inherit-from-`@filterable`
// default resolves through `isSortableField`, the SAME predicate the generated
// `<Entity>SortAllowlist` is built from, so the page cannot say a field is sortable that
// the endpoint will reject. They are deliberately absent from the descriptor: the
// descriptor describes how a field is PRESENTED, while those three say whether it appears
// at all and what the LIST endpoint will accept, which is a different question the form
// control has no opinion on.
//
// THREE THINGS THE DESCRIPTOR ALONE CANNOT ANSWER, each read from the predicate the
// generator that decides it uses, never re-derived here:
//
//   • WHERE the object is served — `restPath`, because a TPH subtype is mounted under its
//     discriminator base and its own `$path` names nothing;
//   • WHETHER a form exists at all — `hasGeneratedForm`, the form generator's own filter,
//     because a discriminator base has a write endpoint and still gets no form;
//   • WHAT the control is for a `field.object` — `valueObjectFor`, shared with the form
//     generator, because a resolvable `@objectRef` is rendered as a nested sub-form and
//     the field's view kind is not consulted.

import {
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_FORM_EXCLUDE,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_SUBTYPE_DATA_GRID,
  TYPE_LAYOUT,
} from "@metaobjectsdev/metadata";
import type { MetaData, MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import { GENERATED_HEADER } from "../constants.js";
import { hasGeneratedForm, restPath, servesReadApi } from "../api-surface.js";
import {
  buildEntityUiDescriptor,
  type UiFieldDescriptor,
  type UiRule,
} from "../templates/entity-ui-descriptor.js";
import { isSortableField } from "../templates/filter-shared.js";
import { isTphDiscriminatorBase } from "../templates/tph-discriminator.js";
import { declaresTphDiscriminator } from "../templates/zod-validators.js";

const GENERATED_MARKER = `<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`;

function mdCell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** One rule, as a reader wants to see it — the value, not the message. */
function ruleText(r: UiRule): string {
  switch (r.kind) {
    case "required":
      return "required";
    case "minLength":
      return `minLength ${r.value}`;
    case "maxLength":
      return `maxLength ${r.value}`;
    case "pattern":
      return `pattern \`${mdCell(r.pattern)}\``;
  }
}

/**
 * The CONTROL cell — what the generated form renders, which is not always a `view.*`
 * subtype.
 *
 * A `field.object` whose `@objectRef` resolves is emitted as a nested `<fieldset>`
 * sub-form (a `useFieldArray` repeatable group when the field is an array), and the form
 * generator never consults the field's view kind for it. This column used to print that
 * view kind — `text`, the `defaultViewForSubType` fallback — which said the control was a
 * free-text input for a field that has no input at all. Same shape as the `field.enum`
 * descriptor bug, one subtype family over; the predicate is shared with the form
 * generator (`valueObjectFor`) so the two cannot answer differently again.
 */
function controlCell(f: UiFieldDescriptor): string {
  if (f.nested === undefined) return `\`${f.view}\``;
  return f.nested.isArray ? "nested sub-form (repeatable)" : "nested sub-form";
}

/** The HTML type cell — empty for a nested sub-form, which is not an input at all. */
function htmlTypeCell(f: UiFieldDescriptor): string {
  if (f.nested !== undefined || f.htmlType === undefined) return "";
  return `\`${f.htmlType}\``;
}

/** `yes` / `` — an empty cell reads better than a column of "no". */
function flag(value: unknown): string {
  return value === true ? "yes" : "";
}

/**
 * The endpoint line under an object's heading.
 *
 * THE `apiPrefix` IS PART OF THE ADDRESS. `routes-file.ts` registers every mount inside
 * `fastify.register(…, { prefix: apiPrefix })`, so a project configuring `/api` serves
 * `/api/owners` and nothing at `/owners`. This page states that its heading is the address
 * the routes mount at, so omitting the prefix made that promise false for every project
 * that sets one — and a reader following it gets a 404.
 *
 * `restPath`, NOT `descriptor.path`: a TPH subtype's own `$path` names an address
 * nothing mounts — the hierarchy is mounted from the discriminator base, each subtype
 * at `<base>/<segment>` — and this page printed that non-existent address as fact.
 * Whether a form exists is `hasGeneratedForm` — the form generator's OWN filter —
 * never `servesWriteApi`. A read-only object (a projection, a view-backed entity) has
 * no Insert/Update schema; a TPH discriminator BASE has both and still gets no form,
 * because you cannot create a base and its polymorphic mount is read-only by
 * construction. Saying so is the difference between "the form is missing" and "there
 * is deliberately no form"; asking the endpoint question announced one for every base.
 */
function endpointLine(obj: MetaObject, root: MetaRoot, apiPrefix: string): string {
  const endpoint = `${apiPrefix}${restPath(obj)}`;
  if (hasGeneratedForm(obj)) return `Endpoint \`${endpoint}\`.`;
  // `isTphDiscriminatorBase`, which requires at least one CONCRETE subtype — the same
  // predicate `routes-file.ts` switches on. `@discriminator` with no subtype yet is a
  // refactor-in-progress shape: the routes generator emits the VANILLA full-CRUD file for
  // it, so "each concrete subtype below has its own" would name subtypes that do not
  // exist, on an object that does have a write endpoint.
  // THREE reasons, not two. `isTphDiscriminatorBase` requires at least one CONCRETE
  // subtype — the same predicate `routes-file.ts` switches on — and the case it excludes
  // is real: an object declaring `@discriminator` with no subtype yet gets the VANILLA
  // full-CRUD routes file, so it is NOT read-only, while the form generator declines it
  // for declaring `@discriminator` at all. Calling that "read-only" is false in the one
  // direction that matters, since a reader would conclude it cannot be written to.
  const reason = isTphDiscriminatorBase(obj, root)
    ? "for a discriminator base — its own mount is list/get only, and each concrete " +
      "subtype below has its own form"
    : declaresTphDiscriminator(obj)
      ? "— the form generator declines any object declaring `@discriminator`, and this " +
        "one has no concrete subtype yet. Its routes are the ordinary full CRUD set"
      : "(read-only)";
  return (
    `Endpoint \`${endpoint}\` — **no form is generated** ${reason}. ` +
    "The fields below describe the grid and the filters."
  );
}

/** The `layout.dataGrid` children an object declares. ADR-0039: resolving. */
function dataGrids(obj: MetaObject): MetaData[] {
  return obj
    .children()
    .filter((c) => c.type === TYPE_LAYOUT && c.subType === LAYOUT_SUBTYPE_DATA_GRID);
}

/**
 * True when a UI generator would emit for this object.
 *
 * `servesReadApi` — the api-surface predicate the hook, grid and form generators
 * themselves gate on — NOT "has fields" and never an object-subtype test. A form, a grid
 * and a hook are all clients of a generated endpoint, so an object with no endpoint has no
 * UI to document.
 *
 * Getting this wrong is not cosmetic. Gating on "has fields" put a prompt payload
 * (`object.value`, no source, no routes) on the page under a heading that announced an
 * endpoint derived from its name — an address that does not exist, stated as fact, on the
 * page an agent is told to trust. Instance artifacts derive from a declared SOURCE; the
 * UI tier asks the endpoint question and never a storage or subtype one.
 */
export function hasUiSurface(obj: MetaObject): boolean {
  return servesReadApi(obj);
}

function gridSection(grid: MetaData): string[] {
  const out: string[] = [];
  out.push(`**Grid \`${grid.name}\`**`);
  out.push("");
  const columns = grid.attr(LAYOUT_DATA_GRID_ATTR_COLUMNS);
  if (Array.isArray(columns) && columns.length > 0) {
    out.push(`- columns: ${columns.map((c) => `\`${String(c)}\``).join(", ")}`);
  }
  const sortField = grid.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD);
  if (typeof sortField === "string" && sortField !== "") {
    const order = grid.attr(LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER);
    const suffix = typeof order === "string" && order !== "" ? `:${order}` : "";
    out.push(`- default sort: \`${sortField}${suffix}\``);
  }
  const pageSize = grid.attr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE);
  if (typeof pageSize === "number") out.push(`- page size: ${pageSize}`);
  return out;
}

/**
 * Render the page. Returns "" when no object in the model has a UI surface — the surface
 * then emits no FILE, so a headless project sees nothing rather than an empty page.
 */
export function renderAgentUiPage(root: MetaRoot, apiPrefix = ""): string {
  const objects = root.objects();
  const withUi = objects.filter(hasUiSurface);
  if (withUi.length === 0) return "";

  const out: string[] = [];
  out.push(GENERATED_MARKER);
  out.push("");
  out.push("# UI");
  out.push("");
  out.push(
    "What the generated forms and grids already are. Read it before changing a form, a " +
      "grid or a filter — the generated `.tsx` is the disposable artifact, this is what " +
      "produced it.",
  );
  out.push("");
  out.push(
    "- Every row here is the SAME derivation the runtime reads — `buildEntityUiDescriptor`, " +
      "which is emitted as the `<Entity>` const in `<Entity>.meta.ts` and consumed by " +
      "`useEntityForm`. Changing the metadata changes both. A READ-ONLY projection's const " +
      "carries the subset that applies to it (no form, so no rules and no HTML type) plus " +
      "the `dbCol` only a view-backed const has.",
  );
  out.push(
    "- `Control` is what the FORM renders. A field declaring several views is described by " +
      "the one named `form`; a `field.object` whose `@objectRef` resolves is not an input " +
      "at all but a nested sub-form over that value object, and says so.",
  );
  out.push(
    "- `Filter` / `Sort` are what the generated LIST endpoint accepts. `@sortable` " +
      "defaults to `@filterable`, and the resolved answer is what is shown.",
  );
  out.push("");

  for (const obj of withUi) {
    out.push(`## \`${obj.resolutionKey()}\``);
    out.push("");
    const descriptor = buildEntityUiDescriptor(obj, root);
    out.push(endpointLine(obj, root, apiPrefix));
    out.push("");
    if (descriptor.fields.length > 0) {
      // The field nodes, keyed by name, so the three non-descriptor columns can be read
      // off the field the descriptor row came from.
      const byName = new Map(obj.fields().map((f) => [f.name, f]));
      out.push("| Field | Label | Control | HTML type | Rules | Excluded | Filter | Sort |");
      out.push("|---|---|---|---|---|---|---|---|");
      for (const f of descriptor.fields) {
        const node = byName.get(f.name);
        const cells = [
          `\`${f.name}\``,
          mdCell(f.label),
          controlCell(f),
          htmlTypeCell(f),
          f.rules.map(ruleText).join(" · "),
          node === undefined ? "" : flag(node.attr(FIELD_ATTR_FORM_EXCLUDE)),
          node === undefined ? "" : flag(node.attr(FIELD_ATTR_FILTERABLE)),
          node === undefined ? "" : flag(isSortableField(node)),
        ];
        out.push(`| ${cells.join(" | ")} |`);
      }
      // Which value object a nested field expands into rides below the table: it is the
      // one thing a reader needs to go and edit, and it does not fit a cell.
      const nested = descriptor.fields.filter((f) => f.nested !== undefined);
      if (nested.length > 0) {
        out.push("");
        for (const f of nested) {
          out.push(
            `- \`${f.name}\` — expands \`${f.nested?.objectRef}\`` +
              `${f.nested?.isArray === true ? ", one group per element" : ""}. Change the ` +
              "fields inside it on that value object, not here.",
          );
        }
      }
      const money = descriptor.fields.filter((f) => f.currency !== undefined);
      if (money.length > 0) {
        out.push("");
        for (const f of money) {
          out.push(
            `- \`${f.name}\` — money: \`${f.currency?.currency}\` formatted for ` +
              `\`${f.currency?.locale}\`. Stored and sent as INTEGER MINOR UNITS; never format it server-side.`,
          );
        }
      }
    }
    for (const grid of dataGrids(obj)) {
      out.push("");
      out.push(...gridSection(grid));
    }
    out.push("");
  }

  return `${out.join("\n").replace(/\n+$/, "")}\n`;
}
