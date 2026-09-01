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
  // `view.month` is registered as "Month picker / month display", and rendered the raw
  // stored string. Parsed field-wise rather than through `new Date("2026-09")`, which is
  // UTC midnight and so displays the PREVIOUS month for every viewer west of Greenwich.
  month: (ctx) => {
    const v = ctx.getValue();
    if (v == null || v === "") return "";
    const m = /^(\d{4})-(\d{2})/.exec(String(v));
    const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, 1) : new Date(String(v));
    return Number.isNaN(d.getTime())
      ? String(v)
      : d.toLocaleDateString(undefined, { year: "numeric", month: "long" });
  },
  // `view.hotlink` is registered as "Renders the value as a clickable link" and rendered
  // plain text — the same broken promise `checkbox` had. The scheme is checked because
  // this value comes from the database: an anchor built blindly from a stored string is
  // a `javascript:` URL away from executing it on click. Anything not http/https/mailto
  // renders as text, which is what it did before, so the guard can only ever be safe.
  hotlink: (ctx) => {
    const v = ctx.getValue();
    const s = v == null ? "" : String(v);
    if (s === "") return "";
    let scheme: string;
    try {
      scheme = new URL(s).protocol;
    } catch {
      return s; // not an absolute URL at all — render it as the text it is
    }
    if (scheme !== "http:" && scheme !== "https:" && scheme !== "mailto:") return s;
    return (
      <a href={s} rel="noreferrer noopener" target="_blank">
        {s}
      </a>
    );
  },
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
  // Same rendering as `dropdown` — a selection control's cell is its chosen value. Keyed
  // explicitly rather than left to EntityGrid's no-renderer fall-through, so that "a radio
  // column shows its value" is a decision this map records instead of an accident.
  radio:    (ctx) => String(ctx.getValue() ?? ""),
  password: () => "•••••",
};
