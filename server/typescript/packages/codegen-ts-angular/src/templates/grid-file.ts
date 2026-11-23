// Angular 18 grid template — emits a per-entity standalone Component that
// renders <mo-entity-grid> with column defs derived from a layout.dataGrid
// metadata child. Mirrors the TanStack columns-file.ts shape (column id +
// header + meta.view) but in Angular-native shape (EntityGridColumn[]).

import { arr, props, str, TsWriter, type Props } from "@metaobjectsdev/codegen-ts";
import type { MetaField, MetaObject, MetaRoot } from "@metaobjectsdev/metadata";
import {
  LAYOUT_SUBTYPE_DATA_GRID,
  LAYOUT_DATA_GRID_ATTR_PAGE_SIZE,
  LAYOUT_DATA_GRID_ATTR_FILTERABLE,
  LAYOUT_DATA_GRID_ATTR_COLUMNS,
  VIEW_SUBTYPE_HIDDEN,
} from "@metaobjectsdev/metadata";
import type { RenderContext } from "@metaobjectsdev/codegen-ts";
import {
  GENERATED_HEADER,
  GENERATED_EDIT_NOTE,
  entityModuleSpecifier,
  viewForContext,
  VIEW_CONTEXT_GRID,
  resolveGridDefaultSort,
  credentialFieldNames,
  type GridDefaultSort,
  effectivePackage,
} from "@metaobjectsdev/codegen-ts";

interface ColumnSpec {
  id:        string;
  header:    string;
  viewKind:  string;
}

interface GridSpec {
  name:               string;
  pageSize:           number;
  // One RESOLVED value, never a field and an order that can disagree — see the same
  // note in codegen-ts-tanstack/src/templates/columns-file.ts. Emitting `defaultSort`
  // only when BOTH layout attrs were present is what silently dropped the initial sort
  // of every grid that named a field and let the field's @sortableDefaultOrder supply
  // the direction.
  defaultSort?:       GridDefaultSort;
  filterable:         boolean;
  columns:            ColumnSpec[];
}

function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (c) => c.toUpperCase());
}

function fieldViewKind(field: MetaField): string {
  // #356: the view declared for the GRID (the same surface the TanStack tier
  // renders), never whichever view came first.
  // ADR-0039: resolving — a field's view may be inherited via extends.
  const view = viewForContext(field, VIEW_CONTEXT_GRID);
  return view?.subType ?? "text";
}

function fieldLabel(field: MetaField): string {
  // #353 — this read `@label`, which no provider registers on any `view.*` subtype, so
  // the override branch was unreachable (ERR_UNKNOWN_ATTR under the strict registry).
  // `title` is the registered common attr that already means "a noun phrase".
  // ADR-0039: resolving — a field's view (and its @title) may be inherited via extends.
  // #356: the GRID's own view — a form control's @title must not retitle a column.
  const viewTitle = viewForContext(field, VIEW_CONTEXT_GRID)?.attr("title");
  if (typeof viewTitle === "string" && viewTitle.length > 0) return viewTitle;
  const fieldTitle = field.attr("title");
  if (typeof fieldTitle === "string" && fieldTitle.length > 0) return fieldTitle;
  return humanize(field.name);
}

function extractGrids(entity: MetaObject, root: MetaRoot): GridSpec[] {
  const fieldsByName = new Map(entity.fields().map((f) => [f.name, f] as const));
  const credentials = credentialFieldNames(entity, root);
  const out: GridSpec[] = [];
  for (const layout of entity.layouts()) {
    if (layout.subType !== LAYOUT_SUBTYPE_DATA_GRID) continue;
    // ADR-0039: resolving — a dataGrid layout may inherit its @* attrs via extends.
    const columnsAttr = layout.attr(LAYOUT_DATA_GRID_ATTR_COLUMNS);
    const columnNames: string[] = Array.isArray(columnsAttr)
      ? (columnsAttr as unknown[]).filter((x): x is string => typeof x === "string")
      : [...fieldsByName.keys()];
    const columns: ColumnSpec[] = columnNames.flatMap((name) => {
      const f = fieldsByName.get(name);
      if (!f) return [];
      // A credential (a `view.password` on any declaration of the column) is never a column,
      // even when @columns names it — the same rule as the TanStack tier and the generated forms.
      if (credentials.has(name)) return [];
      const viewKind = fieldViewKind(f);
      // #355 — `view.hidden` means "not rendered"; drop the column rather than emit one
      // that prints the value. Same rule as the TanStack tier, which renders the same
      // surface (see columns-file.ts for the full reasoning).
      if (viewKind === VIEW_SUBTYPE_HIDDEN) return [];
      return [{ id: name, header: fieldLabel(f), viewKind }];
    });
    // A @defaultSortField naming a credential resolves to no initial sort.
    const defaultSort = resolveGridDefaultSort(entity, layout, root);
    const grid: GridSpec = {
      name: layout.name || "default",
      pageSize: (layout.attr(LAYOUT_DATA_GRID_ATTR_PAGE_SIZE) as number | undefined) ?? 25,
      filterable: layout.attr(LAYOUT_DATA_GRID_ATTR_FILTERABLE) === true,
      columns,
    };
    if (defaultSort !== undefined) grid.defaultSort = defaultSort;
    out.push(grid);
  }
  return out;
}

/** One column definition: `{ id, accessorKey, header, meta: { view } }`. */
function columnDef(col: ColumnSpec): Props {
  return props()
    .set("id", str(col.id))
    .set("accessorKey", str(col.id))
    .set("header", str(col.header))
    .set("meta", props().set("view", str(col.viewKind)));
}

/** The Angular grid component for `entity`, as a file. */
export function renderGridFile(entity: MetaObject, ctx: RenderContext): string {
  const w = new TsWriter();
  writeGridFile(w, entity, ctx);
  return w.toString();
}

/** Write the `<Entity>GridComponent` for `entity`'s first dataGrid layout into `w`. */
export function writeGridFile(w: TsWriter, entity: MetaObject, ctx: RenderContext): void {
  const entityName = entity.name;
  const grids = extractGrids(entity, ctx.loadedRoot);
  const entityModule = entityModuleSpecifier(
    ctx.selfTarget,
    ctx.entityModuleTarget,
    effectivePackage(entity),
    entityName,
    ctx.extStyle,
  );

  // The primary grid drives the component's columns + gridConfig.
  const primary = grids[0];
  if (!primary) {
    // Shouldn't happen — the factory filter requires a dataGrid layout.
    throw new Error(`renderGridFile: no dataGrid layout on ${entityName}`);
  }
  const gridConfig = props()
    .set("name", str(primary.name))
    .set("pageSize", String(primary.pageSize))
    .set("filterable", String(primary.filterable));
  if (primary.defaultSort) {
    gridConfig.set("defaultSort", props()
      .set("field", str(primary.defaultSort.field))
      .set("order", str(primary.defaultSort.order)));
  }

  w.header(
    `// ${GENERATED_HEADER}-angular — ${GENERATED_EDIT_NOTE}`,
    `// Source metadata: ${entityName} (${entity.fqn()})`,
  );
  const row = w.useType(entityName, entityModule, `${entityName}Row`);
  const signal = w.use("signal", "@angular/core");
  const ANGULAR = "@metaobjectsdev/angular";

  w.blank();
  w.doc(
    `Generated Angular grid component for ${entityName}. Wraps <mo-entity-grid>`,
    "with column defs derived from layout.dataGrid metadata. Rows arrive via the",
    "`data` signal — wire it from your component / service.",
  );
  w.block(`@${w.use("Component", "@angular/core")}({`, () => {
    w.line(`selector: ${str(`${entityName.toLowerCase()}-grid`)},`);
    w.line("standalone: true,");
    w.line("imports: ", arr([w.use("CommonModule", "@angular/common"), w.use("EntityGridComponent", ANGULAR)]), ",");
    // The component template is one template literal; its markup nests like any block.
    w.block("template: `", () => {
      w.block("<mo-entity-grid", () => {
        w.line('[columns]="columns"');
        w.line('[data]="data()"');
        w.line('[grid]="gridConfig"');
        w.line('[rowCount]="rowCount()"');
      }, "></mo-entity-grid>");
    }, "`,");
  }, "})");
  w.block(`export class ${entityName}GridComponent {`, () => {
    w.line(`readonly data = ${signal}<${row}[]>([]);`);
    w.line(`readonly rowCount = ${signal}<number>(0);`);
    w.blank();
    w.line(`readonly columns: ${w.useType("EntityGridColumn", ANGULAR)}[] = `, arr(primary.columns.map(columnDef)), ";");
    w.blank();
    w.line(`readonly gridConfig: ${w.useType("GridConfig", ANGULAR)} = `, gridConfig, ";");
  });
}
