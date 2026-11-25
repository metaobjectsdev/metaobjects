import { arr, json, props, str, TsWriter, type Props } from "@metaobjectsdev/codegen-ts/engine";
import type { MetaObject, MetaField, MetaRoot } from "@metaobjectsdev/metadata";
import {
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_FILTER,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  OBJECT_ATTR_DISCRIMINATOR,
  VIEW_SUBTYPE_HIDDEN,
  FILTER_COMPOSE_AND,
  FILTER_COMPOSE_OR,
} from "@metaobjectsdev/metadata";
import type { RenderContext } from "@metaobjectsdev/codegen-ts/engine";
import {
  GENERATED_HEADER,
  GENERATED_EDIT_NOTE,
  entityModuleSpecifier,
  viewForContext,
  VIEW_CONTEXT_GRID,
  effectivePackage,
  flatSurfaceFields,
  tphHierarchy,
} from "@metaobjectsdev/codegen-ts/engine";
import {
  credentialFieldNames,
  isSortableField,
  resolveGridDefaultSort,
  type GridDefaultSort,
} from "@metaobjectsdev/codegen-ts/templates/filter-shared";
import {
  isTphDiscriminatorBase,
  collectTphSubtypeFields,
} from "@metaobjectsdev/codegen-ts/templates/tph-discriminator";

/** FR-017 TPH grid context, threaded into extractGrids when the entity is a
 *  discriminator base: the discriminator field name (badged in the polymorphic
 *  grid) and the subtype-only fields folded in as extra columns. */
interface TphGridInfo {
  discField: string;
  subtypeFields: MetaField[];
}

interface ColumnSpec {
  id:        string;
  header:    string;     // humanized label
  viewKind:  string;     // field's view subtype, falls back to "text"
  sortable?: boolean;
  width?:    number;
  renderer?: string;
}

interface GridSpec {
  name:               string;
  pageSize:           number;
  // One RESOLVED value, never a field and an order that can disagree: emitting
  // `defaultSort` only when BOTH attrs were declared is what silently dropped the
  // initial sort of every grid that named a field and let the field's
  // @sortableDefaultOrder supply the direction.
  defaultSort?:       GridDefaultSort;
  filterable:         boolean;
  filter?:            Record<string, unknown>;   // desugared, load-time-validated @filter object
  columns:            ColumnSpec[];
}

function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function fieldViewKind(field: MetaField): string {
  // #356: the view declared for the GRID, never whichever view came first — a
  // field declaring a form control and a grid cell must render both.
  // ADR-0039: resolving — a field's view may be inherited via extends.
  const view = viewForContext(field, VIEW_CONTEXT_GRID);
  return view?.subType ?? "text";
}

function fieldLabel(field: MetaField): string {
  // #353 — this read `@label`, which NO provider registers, so the override branch was
  // unreachable: authoring it fails the strict load `meta verify` runs (ERR_UNKNOWN_ATTR)
  // and every header fell back to humanize(). `title` is already a registered common attr
  // on every node and already means "a noun phrase", so nothing was registered for this
  // — ADR-0037 step 0: the vocabulary existed, only the read was wrong.
  // View first, then the field itself: a view-level title is the more specific override
  // (this rendering of the field); a field-level one names the field wherever it appears.
  // ADR-0039: resolving — a field's view (and its @title) may be inherited via extends.
  // #356: the GRID's own view — a form control's @title must not retitle a column.
  const viewTitle = viewForContext(field, VIEW_CONTEXT_GRID)?.attr("title");
  if (typeof viewTitle === "string" && viewTitle.length > 0) return viewTitle;
  const fieldTitle = field.attr("title");
  if (typeof fieldTitle === "string" && fieldTitle.length > 0) return fieldTitle;
  return humanize(field.name);
}

/**
 * Every column name a credential occupies anywhere in `entity`'s single table: a TPH base's
 * polymorphic grid folds in subtype-only columns, so the marks of every subtype count, not only
 * the base's own (`credentialFieldNames` answers for one object's own columns).
 */
function gridCredentialNames(entity: MetaObject, root: MetaRoot): ReadonlySet<string> {
  return new Set(tphHierarchy(entity, root).flatMap((o) => [...credentialFieldNames(o, root)]));
}

/**
 * The first credential a grid's `@filter` preset names, at any depth of its `and` / `or`
 * composition, or undefined when it names none.
 */
function credentialInFilter(filter: Record<string, unknown>, credentials: ReadonlySet<string>): string | undefined {
  for (const [key, clause] of Object.entries(filter)) {
    if (key === FILTER_COMPOSE_AND || key === FILTER_COMPOSE_OR) {
      if (!Array.isArray(clause)) continue;
      for (const sub of clause) {
        if (typeof sub !== "object" || sub === null || Array.isArray(sub)) continue;
        const found = credentialInFilter(sub as Record<string, unknown>, credentials);
        if (found !== undefined) return found;
      }
      continue;
    }
    if (credentials.has(key)) return key;
  }
  return undefined;
}

/**
 * Extract grid specs from an entity's dataGrid layouts, resolving column
 * metadata against the entity's field list.
 *
 * Column set: read from @columns stringArray attr on the layout. If absent,
 * fall back to all fields on the entity (pre-E-T2 behaviour, kept for
 * backwards compat with metadata not yet migrated by E-T4).
 */
function extractGrids(entity: MetaObject, root: MetaRoot, tph?: TphGridInfo): GridSpec[] {
  // fields() and layouts() are both effective (own + inherited via extends:/super:).
  // For a TPH base, also index the subtype-only fields so they can be folded
  // into the polymorphic grid's column set.
  const fieldsByName = new Map(
    [...flatSurfaceFields(entity), ...(tph?.subtypeFields ?? [])].map((f) => [f.name, f] as const),
  );

  const credentials = gridCredentialNames(entity, root);

  const grids: GridSpec[] = [];
  for (const layout of entity.layouts()) {
    if (layout.subType !== LAYOUT_SUBTYPE_DATA_GRID) continue;

    // @columns is a stringArray attr on the layout (set by E-T4 migration).
    // Fall back to all entity fields if not present.
    // ADR-0039: resolving — a dataGrid layout may inherit its @* attrs via extends.
    const columnsAttr = layout.attr(LAYOUT_DATA_GRID_ATTR_COLUMNS);
    const columnNames: string[] = Array.isArray(columnsAttr)
      ? (columnsAttr as unknown[]).filter((x): x is string => typeof x === "string")
      : [...fieldsByName.keys()];

    // FR-017: a polymorphic (TPH base) grid folds in every subtype-only column
    // so mixed rows can render their subtype fields (the runtime grid renders a
    // null cell as an em-dash for rows of other subtypes). Appended after the
    // declared columns, deduped.
    if (tph) {
      for (const f of tph.subtypeFields) {
        if (!columnNames.includes(f.name)) columnNames.push(f.name);
      }
    }

    const columns: ColumnSpec[] = columnNames.flatMap((name) => {
      const field = fieldsByName.get(name);
      if (!field) return [];     // columns ref that doesn't exist on entity; defensive skip
      // A credential (a `view.password` on any declaration of the column) is never a column,
      // even when @columns names it: the generated API never returns its value, and a header
      // would offer a sort and a filter the server's allowlists refuse. Same rule as the
      // generated forms, which skip it.
      if (credentials.has(name)) return [];
      const viewKind = fieldViewKind(field);
      // #355 — `view.hidden` is registered as "Not rendered; carried but not shown", and
      // the generated FORM has always honoured that (an <input type="hidden">). The grid
      // did not: no renderer is keyed `hidden`, so EntityGrid's `if (!renderer) return col`
      // fell through to TanStack's default cell and PRINTED the value — the opposite of
      // what the subtype says. Emitting a blank cell would not fix it either: the column
      // would still hold a header and a sort target, so the value would be hidden while
      // the column was not. The column is dropped instead, which is what "not rendered"
      // means. This applies even when @columns names the field: a declaration that the
      // field is a column and a declaration that it is not rendered contradict each other,
      // and the one about RENDERING is the specific answer to the question a grid asks.
      if (viewKind === VIEW_SUBTYPE_HIDDEN) return [];
      const spec: ColumnSpec = {
        id:       name,
        header:   fieldLabel(field),
        viewKind,
        // #352 — ALWAYS emitted, never left absent. EntityGrid gates on
        // `meta?.sortable !== false`, so an omitted flag reads as "offer it" and the
        // header renders clickable for a field the server's SortAllowlist rejects
        // (400 `sort.unknown_field`). isSortableField is the SAME predicate that builds
        // that allowlist — imported (#354), never reimplemented, so the two cannot drift.
        sortable: isSortableField(field),
      };
      // FR-017: the discriminator column renders as a subtype badge.
      if (tph && name === tph.discField) spec.renderer = "badge";
      return [spec];
    });

    // ADR-0039: resolving — dataGrid layout attrs may be inherited via extends.
    // A @defaultSortField naming a credential resolves to no initial sort.
    const defaultSort = resolveGridDefaultSort(entity, layout, root);

    const filterAttr = layout.attr(LAYOUT_DATA_GRID_ATTR_FILTER);
    const grid: GridSpec = {
      name:       layout.name || "default",
      pageSize:   (layout.attr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE) as number | undefined) ?? 25,
      filterable: layout.attr(LAYOUT_DATA_GRID_ATTR_FILTERABLE) === true,
      columns,
    };
    if (defaultSort !== undefined) grid.defaultSort = defaultSort;
    if (typeof filterAttr === "object" && filterAttr !== null && !Array.isArray(filterAttr)) {
      const filter = filterAttr as Record<string, unknown>;
      // A preset filter over a credential is refused, not rewritten. The server's filter
      // allowlist never holds a credential, so the grid's every request would answer 400; and
      // dropping the clause would silently change which rows the grid shows.
      const credential = credentialInFilter(filter, credentials);
      if (credential !== undefined) {
        throw new Error(
          `dataGrid layout "${grid.name}" on entity "${entity.name}" has @filter over credential ` +
            `field "${credential}" (it declares a view.password). A credential is never filterable: ` +
            "remove the clause from @filter.",
        );
      }
      grid.filter = filter;
    }
    grids.push(grid);
  }
  return grids;
}

/** One column definition: `{ id, accessorKey, header, meta: { view, ... } }`. */
function columnDef(col: ColumnSpec): Props {
  const meta = props().set("view", str(col.viewKind));
  if (col.sortable !== undefined) meta.set("sortable", String(col.sortable));
  if (col.width !== undefined) meta.set("width", String(col.width));
  if (col.renderer !== undefined) meta.set("renderer", str(col.renderer));
  return props()
    .set("id", str(col.id))
    .set("accessorKey", str(col.id))
    .set("header", str(col.header))
    .set("meta", meta);
}

/** The grid columns module for `entity`, as a file. */
export function renderColumnsFile(entity: MetaObject, ctx: RenderContext): string {
  const w = new TsWriter();
  writeColumnsFile(w, entity, ctx);
  return w.toString();
}

/** Write the grid columns module for `entity` (one grid const, column list and filter preset per dataGrid). */
export function writeColumnsFile(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  const entityName = entity.name;
  const lcEntity   = entityName.charAt(0).toLowerCase() + entityName.slice(1);
  // FR-017: a TPH discriminator base emits a polymorphic grid typed against the
  // raw single-table row (<Base>Row — all columns, subtype-only nullable),
  // NOT the discriminated union (whose members lack the other subtypes' fields).
  const tphBase = isTphDiscriminatorBase(entity, ctx.loadedRoot);
  const tph: TphGridInfo | undefined = tphBase
    ? {
        // ADR-0039: own — @discriminator is read own to identify the TPH base level
        // (this entity is the base, guarded by isTphDiscriminatorBase above).
        discField: (entity.ownAttr(OBJECT_ATTR_DISCRIMINATOR) as string) ?? "",
        subtypeFields: collectTphSubtypeFields(entity, ctx.loadedRoot),
      }
    : undefined;
  const grids      = extractGrids(entity, ctx.loadedRoot, tph);

  w.header(
    `// ${GENERATED_HEADER}-tanstack — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${entityName} (${entity.fqn()})`,
  );

  // Import the entity's own file. Same target → relative "./Entity"; cross
  // target → importBase-qualified package path.
  const entityModule = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    effectivePackage(entity),
    entityName,
    ctx.extStyle,
  );
  // TPH base: <Base>Row is a distinct export (the all-columns row); import it
  // directly. Non-TPH: the entity type IS the row, imported under the Row alias.
  // <Entity>Filter is imported only by a grid that emits a filter const.
  const row = tphBase
    ? w.useType(`${entityName}Row`, entityModule)
    : w.useType(entityName, entityModule, `${entityName}Row`);
  const columnDefType = w.useType("ColumnDef", "@tanstack/react-table");

  for (const grid of grids) {
    const gridConst = props()
      .set("name", str(grid.name))
      .set("pageSize", String(grid.pageSize));
    if (grid.defaultSort) {
      gridConst.set("defaultSort", props()
        .set("field", str(grid.defaultSort.field))
        .set("order", `${str(grid.defaultSort.order)} as const`));
    }
    gridConst.set("filterable", String(grid.filterable));
    w.blank();
    w.line(`export const ${lcEntity}${capitalize(grid.name)}Grid = `, gridConst, ";");
    w.blank();
    w.line(`export const ${lcEntity}${capitalize(grid.name)}Columns: ${columnDefType}<${row}>[] = `, arr(grid.columns.map(columnDef)), ";");
    // Emit per-grid filter const when @filter is set. The value is already a
    // desugared, load-time-validated object — emit it verbatim.
    if (grid.filter !== undefined) {
      const filterType = w.useType(`${entityName}Filter`, entityModule);
      w.blank();
      w.line(`export const ${lcEntity}${capitalize(grid.name)}Filter: ${filterType} = `, json(grid.filter), ";");
    }
  }
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
