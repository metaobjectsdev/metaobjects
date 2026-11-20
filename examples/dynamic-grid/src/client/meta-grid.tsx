/**
 * `<MetaGrid entity="WorkOrder" />`: a list of any entity, from its name alone.
 *
 * Columns, headers, page size and the initial sort come from the entity's `layout.dataGrid`;
 * which columns sort, which fields filter and with which operators come from the fields'
 * `@sortable` / `@filterable` and subtype; a foreign key shows the row it points at. All of
 * it is read from the model the server serves at `/_meta`, when the component renders.
 *
 * The table itself is `EntityGrid` from `@metaobjectsdev/tanstack`, the same component the
 * generated grids render with. What differs is where its columns come from.
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { ColumnDef, PaginationState, SortingState } from "@tanstack/react-table";
import {
  FIELD_SUBTYPE_BOOLEAN,
  FILTER_OP_EQ,
  FILTER_OP_GT,
  FILTER_OP_GTE,
  FILTER_OP_IN,
  FILTER_OP_IS_NULL,
  FILTER_OP_LIKE,
  FILTER_OP_LT,
  FILTER_OP_LTE,
  FILTER_OP_NE,
  type FilterOp,
} from "@metaobjectsdev/metadata/constants";
import { buildFilterQs } from "@metaobjectsdev/runtime-web";
import { EntityGrid, useEntityPathFetcher } from "@metaobjectsdev/tanstack";
import { describeError, type Row } from "./api";
import { useEntity, useModel } from "./context";
import { FieldInput } from "./controls";
import { displayValue } from "./format";
import { controlFor, type ControlKind } from "./form-values";
import type { EntityModel, FieldModel } from "./model";
import { useReferenceTitles } from "./references";

export interface MetaGridProps {
  /** The entity to list, by the name the metadata gives it. Nothing else is required. */
  readonly entity: string;
  /** List only the rows where these fields have these values (the lines of one work order). */
  readonly where?: Readonly<Record<string, string | number>>;
  readonly onOpen?: (row: Row) => void;
  /** Change it to fetch the page again, after a row was written elsewhere. */
  readonly refresh?: number;
}

/** One filter a person added: `status` `in` `open,done`. */
interface ActiveFilter {
  readonly field: string;
  readonly op: FilterOp;
  readonly value: string;
}

const OP_LABELS: Readonly<Record<FilterOp, string>> = {
  [FILTER_OP_EQ]: "is",
  [FILTER_OP_NE]: "is not",
  [FILTER_OP_GT]: "is more than",
  [FILTER_OP_GTE]: "is at least",
  [FILTER_OP_LT]: "is less than",
  [FILTER_OP_LTE]: "is at most",
  [FILTER_OP_IN]: "is one of",
  [FILTER_OP_LIKE]: "matches",
  [FILTER_OP_IS_NULL]: "is empty",
};

const YES_NO: ReactNode = (
  <>
    <option value="true">Yes</option>
    <option value="false">No</option>
  </>
);

/**
 * The input a filter value is typed into. The same choice the form makes for the field,
 * except that money is filtered by its stored minor units and long text by a single line.
 */
function filterControl(field: FieldModel): Exclude<ControlKind, "group" | "checkbox" | "currency" | "textarea"> | undefined {
  const kind = controlFor(field);
  if (kind === "currency") return "integer";
  if (kind === "textarea") return "text";
  return kind === "group" || kind === "checkbox" ? undefined : kind;
}

function FilterBar(props: {
  readonly entity: EntityModel;
  readonly filters: readonly ActiveFilter[];
  readonly onChange: (filters: readonly ActiveFilter[]) => void;
}): ReactNode {
  const fields = props.entity.fields.filter((f) => f.filterOps.length > 0);
  const [fieldName, setFieldName] = useState(fields[0]?.name ?? "");
  const field = fields.find((f) => f.name === fieldName);
  const [chosenOp, setChosenOp] = useState<FilterOp | undefined>(undefined);
  const [value, setValue] = useState("");
  if (field === undefined) return null;

  // The operator shown is always one this field takes: picking another field resets it.
  const op = chosenOp !== undefined && field.filterOps.includes(chosenOp) ? chosenOp : field.filterOps[0];
  if (op === undefined) return null;
  const yesNo = op === FILTER_OP_IS_NULL || field.subType === FIELD_SUBTYPE_BOOLEAN;
  const kind = filterControl(field);
  const typed = yesNo && value === "" ? "true" : value;
  const id = `${props.entity.name}-filter`;

  const add = (): void => {
    if (typed.trim() === "") return;
    // One filter per field and operator: adding it again replaces the earlier value.
    const others = props.filters.filter((f) => !(f.field === field.name && f.op === op));
    props.onChange([...others, { field: field.name, op, value: typed.trim() }]);
    setValue("");
  };

  return (
    <div className="mo-filters" role="group" aria-label={`Filter ${props.entity.label}`}>
      <select
        aria-label="Filter field"
        value={field.name}
        onChange={(e) => {
          setFieldName(e.target.value);
          setValue("");
        }}
      >
        {fields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.label}
          </option>
        ))}
      </select>
      <select
        aria-label="Filter operator"
        value={op}
        onChange={(e) => {
          setChosenOp(field.filterOps.find((o) => o === e.target.value));
          setValue("");
        }}
      >
        {field.filterOps.map((o) => (
          <option key={o} value={o}>
            {OP_LABELS[o]}
          </option>
        ))}
      </select>
      {yesNo ? (
        <select aria-label="Filter value" value={typed} onChange={(e) => setValue(e.target.value)}>
          {YES_NO}
        </select>
      ) : op === FILTER_OP_IN || op === FILTER_OP_LIKE || kind === undefined ? (
        <input
          aria-label="Filter value"
          type="text"
          value={value}
          placeholder={op === FILTER_OP_IN ? "one, two, three" : op === FILTER_OP_LIKE ? "starts with… (% is any text)" : ""}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
      ) : (
        <FieldInput field={field} kind={kind} id={id} label="Filter value" value={value} onChange={(v) => setValue(typeof v === "string" ? v : "")} />
      )}
      <button type="button" onClick={add} disabled={typed.trim() === ""}>
        Add filter
      </button>
      {props.filters.map((f) => (
        <button
          key={`${f.field}:${f.op}`}
          type="button"
          className="mo-chip"
          aria-label={`Remove filter ${f.field} ${f.op}`}
          onClick={() => props.onChange(props.filters.filter((other) => other !== f))}
        >
          {props.entity.field(f.field)?.label ?? f.field} {OP_LABELS[f.op]}
          {f.op === FILTER_OP_IS_NULL ? (f.value === "true" ? "" : " (no)") : ` ${f.value}`} ×
        </button>
      ))}
    </div>
  );
}

/** The columns of the entity's grid layout, each drawn by the field's own metadata. */
function useColumns(entity: EntityModel, rows: readonly Row[]): ColumnDef<Row>[] {
  const titleOf = useReferenceTitles(entity, rows);
  return useMemo(
    () =>
      entity.grid.columns.flatMap((column): ColumnDef<Row>[] => {
        const field = entity.field(column.field);
        if (field === undefined) return [];
        return [
          {
            id: field.name,
            accessorFn: (row) => row[field.name],
            header: column.header,
            enableSorting: field.sortable,
            meta: { sortable: field.sortable, view: column.viewKind },
            cell: (ctx) => titleOf(field, ctx.getValue()) ?? displayValue(field, ctx.getValue()),
          },
        ];
      }),
    [entity, titleOf],
  );
}

function Grid(props: MetaGridProps & { readonly model: EntityModel }): ReactNode {
  const entity = props.model;
  const { maxLimit } = useModel();
  const fetcher = useEntityPathFetcher();
  const config = entity.grid.config;
  // The layout's page size, but never more than the server will serve.
  const pageSize = maxLimit === undefined ? config.pageSize : Math.min(config.pageSize, maxLimit);

  const [sorting, setSorting] = useState<SortingState>(
    config.defaultSort === undefined ? [] : [{ id: config.defaultSort.field, desc: config.defaultSort.order === "desc" }],
  );
  const [pagination, setPagination] = useState<PaginationState>({ pageIndex: 0, pageSize });
  const [filters, setFilters] = useState<readonly ActiveFilter[]>([]);
  const [page, setPage] = useState<{ rows: Row[]; total: number }>({ rows: [], total: 0 });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(undefined);

  const where = props.where;
  const query = useMemo(() => {
    const filter: Record<string, Record<string, string>> = {};
    for (const [name, value] of Object.entries(where ?? {})) filter[name] = { [FILTER_OP_EQ]: String(value) };
    for (const f of filters) filter[f.field] = { ...filter[f.field], [f.op]: f.value };
    const sort = sorting[0];
    return buildFilterQs({
      ...filter,
      limit: pagination.pageSize,
      offset: pagination.pageIndex * pagination.pageSize,
      withCount: 1,
      ...(sort !== undefined ? { sort: `${sort.id}:${sort.desc ? "desc" : "asc"}` } : {}),
    });
    // `where` is compared by content: a caller passes a new object on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(where), filters, sorting, pagination]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    fetcher<{ rows: Row[]; total: number }>(`${entity.path}?${query}`).then(
      (answer) => {
        if (!live) return;
        setPage(answer);
        setError(undefined);
        setLoading(false);
      },
      (err: unknown) => {
        if (!live) return;
        setError(err);
        setLoading(false);
      },
    );
    return () => {
      live = false;
    };
  }, [fetcher, entity.path, query, props.refresh]);

  const columns = useColumns(entity, page.rows);
  const toFirstPage = (): void => setPagination((current) => ({ ...current, pageIndex: 0 }));

  return (
    <section className="mo-grid" aria-label={`${entity.label} list`} aria-busy={loading}>
      {config.filterable && (
        <FilterBar
          entity={entity}
          filters={filters}
          onChange={(next) => {
            setFilters(next);
            toFirstPage();
          }}
        />
      )}
      {error !== undefined && <p role="alert">{describeError(error)}</p>}
      <EntityGrid<Row>
        columns={columns}
        grid={config}
        data={page.rows}
        rowCount={page.total}
        state={{ sorting, pagination, columnFilters: [] }}
        onSortingChange={(next) => {
          setSorting(next);
          toFirstPage();
        }}
        onPaginationChange={setPagination}
        onColumnFiltersChange={() => undefined}
        isLoading={loading}
        paginationClassName="mo-pagination"
        {...(props.onOpen !== undefined ? { onRowClick: props.onOpen } : {})}
      />
      <p className="mo-count">
        {loading ? "Loading…" : page.total === 0 ? "No rows." : `${page.total} ${page.total === 1 ? "row" : "rows"}`}
      </p>
    </section>
  );
}

export function MetaGrid(props: MetaGridProps): ReactNode {
  const model = useModel();
  const entity = useEntity(props.entity);
  // Keyed by entity and model revision: another entity, or a reloaded model, starts a
  // fresh grid (its own sort, page and filters) instead of reusing the last one's state.
  return <Grid key={`${entity.name}@${model.revision}`} {...props} model={entity} />;
}
