import type { CellContext } from "@tanstack/react-table";
import type { ReactNode } from "react";
import { formatCurrency, type ImageUploadAdapter } from "@metaobjectsdev/runtime-web";

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

/** Presentation knobs for {@link imageCell}. Both have defaults; neither is metadata —
 *  a column's `meta` carries only view/sortable/width/renderer, so `view.image`'s
 *  @aspectRatio / @maxEdge do not reach the grid. */
export interface ImageCellOptions {
  /** Rendered edge length in px (square thumbnail). Default 32. */
  size?: number;
  /** Alt text. Defaults to "" — the row around the cell already carries the meaning,
   *  and announcing an opaque storage key is worse than announcing nothing. */
  alt?: string;
}

/**
 * Cell renderer for a `view.image` column, closed over the app's upload/serve adapter.
 *
 * A FACTORY rather than a `defaultCellRenderers` key, and deliberately: the field stores
 * an opaque storage key, so turning it into a `src` requires `ImageUploadAdapter.imageUrl`
 * — and the adapter's React context lives in `@metaobjectsdev/react`, which declares
 * `react-hook-form` and `@hookform/resolvers` as REQUIRED peers. A dependency edge from
 * this package would make every grid-only consumer responsible for a form stack it never
 * uses, and `peerDependencies` are declared per PACKAGE, so no subpath or export-map change
 * reaches that. The app supplies the adapter instead:
 *
 *     <CellRendererProvider value={{ image: imageCell(adapter) }}>
 *
 * Only the adapter's TYPE is imported here, from a package this one already depends on, so
 * the helper costs nothing at install or bundle time.
 */
export function imageCell(adapter: ImageUploadAdapter, opts: ImageCellOptions = {}): CellRenderer {
  const size = opts.size ?? 32;
  const alt = opts.alt ?? "";
  return (ctx) => {
    const v = ctx.getValue();
    const key = v == null ? "" : String(v);
    if (key === "") return "";
    let src: string;
    try {
      src = adapter.imageUrl(key);
    } catch {
      // An adapter that cannot resolve the key: render the key as the text it is, the
      // same fall-back `hotlink` makes for a value that is not a URL. There is no
      // harmless empty-src alternative — an <img src=""> resolves to the PAGE url and
      // re-requests it.
      return key;
    }
    return (
      <img
        src={src}
        alt={alt}
        width={size}
        height={size}
        loading="lazy"
        style={{ objectFit: "cover" }}
      />
    );
  };
}
