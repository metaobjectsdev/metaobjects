// DEPRECATED — re-export shim. Package deletes in FR-002 Phase 2 Task 10.
// New imports should target @metaobjects/runtime-web, @metaobjects/react,
// or @metaobjects/tanstack directly.
export { formatCurrency, parseCurrency, minorUnitsFor } from "@metaobjects/runtime-web";
export type { EntityFetcher, GridConfig } from "@metaobjects/runtime-web";
export { buildFilterQs } from "@metaobjects/runtime-web";
export {
  useEntityForm,
  type EntityFieldMeta,
  type EntityMeta,
  type BoundInputProps,
  type InputAccessor,
  type UseEntityFormOptions,
  type UseEntityFormReturn,
  CurrencyInput,
  type CurrencyInputProps,
} from "@metaobjects/react";
export {
  EntityFetcherProvider,
  useEntityFetcher,
  type EntityFetcherProviderProps,
  defaultCellRenderers,
  type CellRenderer,
  CellRendererProvider,
  useCellRenderers,
  type CellRendererProviderProps,
  EntityGrid,
  type EntityGridProps,
  type EntityGridState,
} from "@metaobjects/tanstack";
