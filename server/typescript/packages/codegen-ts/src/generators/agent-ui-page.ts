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
// The two columns the descriptor does NOT carry — `@formExclude` and
// `@filterable`/`@sortable` — are read here from the field. They are deliberately absent
// from the descriptor: the descriptor describes how a field is PRESENTED, while those
// three say whether it appears at all and what the LIST endpoint will accept, which is a
// different question the form control has no opinion on.

import {
  FIELD_ATTR_FILTERABLE,
  FIELD_ATTR_FORM_EXCLUDE,
  FIELD_ATTR_SORTABLE,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_FIELD,
  LAYOUT_DATA_GRID_ATTR_DEFAULT_SORT_ORDER,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_SUBTYPE_DATA_GRID,
  TYPE_LAYOUT,
} from "@metaobjectsdev/metadata";
import type { MetaData, MetaField, MetaObject } from "@metaobjectsdev/metadata";
import { GENERATED_HEADER } from "../constants.js";
import { servesReadApi, servesWriteApi } from "../api-surface.js";
import { buildEntityUiDescriptor, type UiRule } from "../templates/entity-ui-descriptor.js";

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

/** `yes` / `` — an empty cell reads better than a column of "no". */
function flag(value: unknown): string {
  return value === true ? "yes" : "";
}

/**
 * `@sortable` inherits from `@filterable` when unset — the documented default. Rendering
 * the resolved answer rather than the authored one is the point: an agent asking "can I
 * sort on this?" needs what the endpoint will ACCEPT.
 */
function sortableOf(field: MetaField): boolean {
  const own = field.attr(FIELD_ATTR_SORTABLE);
  if (typeof own === "boolean") return own;
  return field.attr(FIELD_ATTR_FILTERABLE) === true;
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
export function renderAgentUiPage(objects: readonly MetaObject[]): string {
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
    "- Every row here is the SAME derivation the runtime reads: it is emitted as the " +
      "`<Entity>` const in `<Entity>.meta.ts`, which `useEntityForm` consumes. Changing " +
      "the metadata changes both.",
  );
  out.push(
    "- `View` is the control the FORM renders. A field declaring several views is " +
      "described by the one named `form`.",
  );
  out.push(
    "- `Filter` / `Sort` are what the generated LIST endpoint accepts. `@sortable` " +
      "defaults to `@filterable`, and the resolved answer is what is shown.",
  );
  out.push("");

  for (const obj of withUi) {
    out.push(`## \`${obj.resolutionKey()}\``);
    out.push("");
    const descriptor = buildEntityUiDescriptor(obj);
    // A read-only object (a projection, a view-backed entity) has no Insert/Update schema,
    // so no form is generated for it and there is nothing for one to submit to. Saying so
    // is the difference between "the form is missing" and "there is deliberately no form".
    out.push(
      servesWriteApi(obj)
        ? `Endpoint \`${descriptor.path}\`.`
        : `Endpoint \`${descriptor.path}\` — **read-only**, so no form is generated. ` +
            "The fields below describe the grid and the filters.",
    );
    out.push("");
    if (descriptor.fields.length > 0) {
      // The field nodes, keyed by name, so the three non-descriptor columns can be read
      // off the field the descriptor row came from.
      const byName = new Map(obj.fields().map((f) => [f.name, f]));
      out.push("| Field | Label | View | HTML type | Rules | Excluded | Filter | Sort |");
      out.push("|---|---|---|---|---|---|---|---|");
      for (const f of descriptor.fields) {
        const node = byName.get(f.name);
        const rules = f.rules.map(ruleText).join(" · ");
        out.push(
          `| \`${f.name}\` | ${mdCell(f.label)} | \`${f.view}\` | ` +
            `${f.htmlType === undefined ? "" : `\`${f.htmlType}\``} | ${rules} | ` +
            `${node === undefined ? "" : flag(node.attr(FIELD_ATTR_FORM_EXCLUDE))} | ` +
            `${node === undefined ? "" : flag(node.attr(FIELD_ATTR_FILTERABLE))} | ` +
            `${node === undefined ? "" : flag(sortableOf(node))} |`,
        );
      }
      // Placeholder / help text ride below: both are prose, and most fields have neither.
      const prose = descriptor.fields.filter(
        (f) => f.placeholder !== undefined || f.helpText !== undefined,
      );
      if (prose.length > 0) {
        out.push("");
        for (const f of prose) {
          const bits: string[] = [];
          if (f.placeholder !== undefined) bits.push(`placeholder: "${f.placeholder}"`);
          if (f.helpText !== undefined) bits.push(`help: "${f.helpText}"`);
          out.push(`- \`${f.name}\` — ${bits.join(" · ")}`);
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
