// Public API surface for @metaobjectsdev/angular.
export { EntityFetcherToken, provideEntityFetcher } from "./entity-fetcher.token.js";
export { CurrencyInputComponent } from "./currency-input.component.js";
export {
  CellRendererRegistry,
  type CellRendererInputs,
  type CellRendererComponent,
} from "./cell-renderer.registry.js";
export {
  EntityGridComponent,
  type EntityGridColumn,
} from "./entity-grid.component.js";

// Re-exports from runtime-web — single import path for consumers.
export type { EntityFetcher, GridConfig } from "@metaobjectsdev/runtime-web";
export {
  formatCurrency,
  parseCurrency,
  minorUnitsFor,
  buildFilterQs,
} from "@metaobjectsdev/runtime-web";
