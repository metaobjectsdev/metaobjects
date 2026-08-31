import type { CellContext } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { formatCurrency } from "@metaobjectsdev/runtime-web";

export type CellRenderer = (ctx: CellContext<any, any>) => ReactNode;

/**
 * Default cell renderers keyed by field `view` subtype.
 * Apps override per-key via <CellRendererProvider>.
 */
export const defaultCellRenderers: Record<string, CellRenderer> = {
  text:     (ctx) => String(ctx.getValue() ?? ""),
  textarea: (ctx) => String(ctx.getValue() ?? ""),
  number:   (ctx) => String(ctx.getValue() ?? ""),
  date:     (ctx) => {
    const v = ctx.getValue();
    return v ? new Date(v as string).toLocaleDateString() : "";
  },
  // #355 — keyed by REGISTERED view subtype. `checkbox` is the registered subtype for a
  // boolean-valued view; this renderer previously sat under `boolean`, which no subtype
  // produces, so it was unreachable and a checkbox column rendered a raw true/false.
  checkbox: (ctx) => (ctx.getValue() ? "Yes" : "No"),
  currency: (ctx) => {
    const value = ctx.getValue();
    if (value == null || !Number.isFinite(Number(value))) return "";
    const meta = (ctx.column.columnDef.meta ?? {}) as { currency?: string; locale?: string };
    try {
      return formatCurrency(value as number, meta.currency, meta.locale);
    } catch {
      // Invalid currency code or unsupported locale — fall back to raw value
      return String(value);
    }
  },
  dropdown: (ctx) => String(ctx.getValue() ?? ""),
  password: () => "•••••",
};
