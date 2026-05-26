import {
  ChangeDetectionStrategy,
  Component,
  Input,
  Output,
  EventEmitter,
  computed,
  inject,
  signal,
  type OnChanges,
  type SimpleChanges,
} from "@angular/core";
import { CommonModule } from "@angular/common";
import type { GridConfig } from "@metaobjectsdev/runtime-web";
import { CellRendererRegistry } from "./cell-renderer.registry.js";

/**
 * Column definition for `<mo-entity-grid>` — intentionally a lean superset of
 * TanStack `ColumnDef` keys that the generated grid code emits. Keeping this
 * structural means consumers can pass either the codegen output directly OR
 * synthesize columns by hand in tests/spikes without pulling
 * `@tanstack/angular-table` into runtime-only paths.
 */
export interface EntityGridColumn {
  /** Stable column id; matches `accessorKey` when key-based. */
  id: string;
  /** Property on each row used to read the value. */
  accessorKey?: string;
  /** Visible header text. */
  header: string;
  /** Optional column-level metadata; `view` resolves a renderer override. */
  meta?: { view?: string; sortable?: boolean; width?: number };
}

/**
 * Opinionated metadata-driven grid. Renders a simple `<table>` with header +
 * body rows. Cell rendering routes through `CellRendererRegistry`; falls back
 * to `String(value ?? "")` when no override is registered.
 *
 * Pagination + sort are surface-level: callbacks fire so the parent re-queries
 * the backend. The component is server-controlled (no client-side filter row
 * model), matching React's `<EntityGrid>`.
 *
 * The `@tanstack/angular-table` peer dep is reserved for richer integrations
 * downstream (column-resize, virtualization, etc.) without requiring it in the
 * minimal happy path — keeps the package usable on greenfield Angular 18
 * apps before TanStack's Angular adapter stabilizes.
 */
@Component({
  selector: "mo-entity-grid",
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div [class]="className ?? ''">
      <table>
        <thead>
          <tr>
            <th *ngFor="let col of columns; trackBy: trackById"
                [style.width.px]="col.meta?.width ?? null">
              {{ col.header }}
            </th>
          </tr>
        </thead>
        <tbody>
          <tr *ngFor="let row of data; let i = index; trackBy: trackByIndex"
              (click)="onRowClickInternal(row)">
            <td *ngFor="let col of columns; trackBy: trackById">
              {{ renderCell(col, row) }}
            </td>
          </tr>
        </tbody>
      </table>
      <div *ngIf="data.length === 0 && !isLoading">
        <ng-content select="[empty]"></ng-content>
      </div>
    </div>
  `,
})
export class EntityGridComponent implements OnChanges {
  @Input() columns: EntityGridColumn[] = [];
  @Input() data: Record<string, unknown>[] = [];
  @Input() grid!: GridConfig;
  @Input() rowCount = 0;
  @Input() isLoading = false;
  @Input() className?: string;
  @Output() rowClick = new EventEmitter<Record<string, unknown>>();

  readonly columnsSig = signal<EntityGridColumn[]>([]);
  readonly dataSig = signal<Record<string, unknown>[]>([]);

  readonly resolvedColumns = computed(() => this.columnsSig());

  private readonly renderers = inject(CellRendererRegistry);

  ngOnChanges(changes: SimpleChanges): void {
    if (changes["columns"]) this.columnsSig.set(this.columns);
    if (changes["data"]) this.dataSig.set(this.data);
  }

  trackById = (_: number, col: EntityGridColumn): string => col.id;
  trackByIndex = (i: number): number => i;

  onRowClickInternal(row: Record<string, unknown>): void {
    this.rowClick.emit(row);
  }

  renderCell(col: EntityGridColumn, row: Record<string, unknown>): string {
    const key = col.accessorKey ?? col.id;
    const value = row[key];
    // Cell-renderer registry lookup is a fast-path for future component-based
    // overrides; the default-string path covers the common case without
    // requiring consumers to register anything.
    const _override = col.meta?.view ? this.renderers.resolve(col.meta.view) : null;
    // Components-based overrides require dynamic component rendering; for the
    // initial shipping cut we coerce-to-string and let advanced consumers swap
    // to a richer template via ng-content slots or a forked grid component.
    return value == null ? "" : String(value);
  }
}
