import type { CellContext } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { formatCurrency } from "@metaobjects/runtime-web";

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
  datetime: (ctx) => {
    const v = ctx.getValue();
    return v ? new Date(v as string).toLocaleString() : "";
  },
  boolean:  (ctx) => (ctx.getValue() ? "Yes" : "No"),
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
