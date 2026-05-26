import { Injectable, type Type } from "@angular/core";

/**
 * Public contract a cell-renderer Angular component must implement: it accepts
 * `value: unknown` as an `@Input()` (or signal input) and renders it as the
 * grid cell body.
 */
export interface CellRendererInputs {
  value: unknown;
}

export type CellRendererComponent = Type<CellRendererInputs>;

/**
 * App-wide registry mapping `view.<subtype>` keys to Angular components used
 * to render those cells in `<mo-entity-grid>`. Mirrors React's
 * `<CellRendererProvider>`, but uses Angular DI instead of context.
 *
 * Defaults to empty — `<mo-entity-grid>` falls back to a string-coercing
 * built-in renderer when no component is registered for a subtype. Consumers
 * register per-view overrides at application bootstrap or per-feature module.
 */
@Injectable({ providedIn: "root" })
export class CellRendererRegistry {
  private readonly registry = new Map<string, CellRendererComponent>();

  /** Register or replace the component for a given `view.<subtype>` key. */
  register(viewSubtype: string, component: CellRendererComponent): void {
    this.registry.set(viewSubtype, component);
  }

  /** Lookup; returns null when no override is registered for the subtype. */
  resolve(viewSubtype: string): CellRendererComponent | null {
    return this.registry.get(viewSubtype) ?? null;
  }

  /** Test helper. */
  clear(): void {
    this.registry.clear();
  }
}
