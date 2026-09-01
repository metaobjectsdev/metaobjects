import { describe, test, expect } from "bun:test";
import "./setup.js";
import { renderHook } from "@testing-library/react";
import {
  defaultCellRenderers,
  imageCell,
  CellRendererProvider,
  useCellRenderers,
} from "../src/index.js";
import type { ImageUploadAdapter } from "@metaobjectsdev/runtime-web";

const ctx = (value: unknown) => ({ getValue: () => value }) as any;

describe("defaultCellRenderers", () => {
  test("text renders the value as a string", () => {
    expect(defaultCellRenderers.text!(ctx("hello"))).toBe("hello");
    expect(defaultCellRenderers.text!(ctx(null))).toBe("");
  });
  test("checkbox renders Yes/No", () => {
    expect(defaultCellRenderers.checkbox!(ctx(true))).toBe("Yes");
    expect(defaultCellRenderers.checkbox!(ctx(false))).toBe("No");
  });
  test("date renders a locale date string", () => {
    const out = defaultCellRenderers.date!(ctx("2026-05-13T10:00:00Z")) as string;
    expect(out).toMatch(/2026|13|May/);
  });
  test("password renders masked dots", () => {
    expect(defaultCellRenderers.password!(ctx("secret"))).toBe("•••••");
  });
  test("radio renders the chosen value, like dropdown", () => {
    expect(defaultCellRenderers.radio!(ctx("PASS"))).toBe("PASS");
    expect(defaultCellRenderers.radio!(ctx(null))).toBe("");
  });
});

// #355 residue — `hotlink` and `month` were registered view subtypes with NO renderer, so
// EntityGrid's `if (!renderer) return col` fell through to TanStack's default cell and each
// rendered its raw value: exactly the shape that left `checkbox` printing true/false.
describe("defaultCellRenderers.hotlink", () => {
  const href = (out: unknown): string | undefined =>
    (out as { props?: { href?: string } } | null)?.props?.href;

  test("an http(s) value becomes an anchor", () => {
    expect(href(defaultCellRenderers.hotlink!(ctx("https://example.com/x"))))
      .toBe("https://example.com/x");
    expect(href(defaultCellRenderers.hotlink!(ctx("http://example.com"))))
      .toBe("http://example.com");
    expect(href(defaultCellRenderers.hotlink!(ctx("mailto:someone@example.com"))))
      .toBe("mailto:someone@example.com");
  });

  test("a javascript: value renders as TEXT, never as an anchor", () => {
    // The cell value comes from the database. An anchor built blindly from a stored string
    // executes that string on click, so the scheme check is the whole point of the renderer
    // rather than a nicety — and it must be asserted, not assumed.
    const out = defaultCellRenderers.hotlink!(ctx("javascript:alert(1)"));
    expect(out).toBe("javascript:alert(1)");
    expect(href(out)).toBeUndefined();
  });

  test("a non-URL value renders as the text it is", () => {
    expect(defaultCellRenderers.hotlink!(ctx("not a url"))).toBe("not a url");
    expect(defaultCellRenderers.hotlink!(ctx(null))).toBe("");
  });
});

describe("defaultCellRenderers.month", () => {
  test("a YYYY-MM value renders as that month, in every timezone", () => {
    // `new Date("2026-09")` is UTC midnight, so the obvious implementation shows AUGUST to
    // every viewer west of Greenwich. Asserted under a negative-offset TZ, which is where
    // the naive version fails and the shipped one does not.
    const prev = process.env.TZ;
    try {
      process.env.TZ = "America/Los_Angeles";
      const out = defaultCellRenderers.month!(ctx("2026-09")) as string;
      expect(out).toContain("2026");
      expect(out).not.toMatch(/Aug/i);
    } finally {
      if (prev === undefined) delete process.env.TZ;
      else process.env.TZ = prev;
    }
  });

  test("an unparseable value falls back to the raw string", () => {
    expect(defaultCellRenderers.month!(ctx("whenever"))).toBe("whenever");
    expect(defaultCellRenderers.month!(ctx(null))).toBe("");
  });
});

describe("useCellRenderers (no provider)", () => {
  test("returns the defaults when no CellRendererProvider is present", () => {
    const { result } = renderHook(() => useCellRenderers());
    expect(result.current.text).toBeDefined();
    expect(result.current.checkbox).toBeDefined();
  });
});

describe("CellRendererProvider", () => {
  test("overrides specific keys; defaults remain for unspecified keys", () => {
    const override = { checkbox: (c: any) => (c.getValue() ? "YES!" : "NO!") };
    const { result } = renderHook(() => useCellRenderers(), {
      wrapper: ({ children }) => (
        <CellRendererProvider value={override}>{children}</CellRendererProvider>
      ),
    });
    expect(result.current.checkbox!(ctx(true))).toBe("YES!");
    expect(result.current.text).toBe(defaultCellRenderers.text);
  });

  test("nested providers compose: inner wins for overlapping keys", () => {
    const outer = { checkbox: () => "outer" } as any;
    const inner = { checkbox: () => "inner" } as any;
    const { result } = renderHook(() => useCellRenderers(), {
      wrapper: ({ children }) => (
        <CellRendererProvider value={outer}>
          <CellRendererProvider value={inner}>{children}</CellRendererProvider>
        </CellRendererProvider>
      ),
    });
    expect(result.current.checkbox!(ctx(true))).toBe("inner");
  });
});

// The `view.image` column is the one registered subtype whose cell CANNOT be rendered from
// the value alone: the field stores an opaque storage key, and turning that into a `src`
// needs the app's ImageUploadAdapter. So the renderer ships as a FACTORY the app closes over
// its adapter with, rather than as a `defaultCellRenderers` key — see the `image` exemption
// in codegen-ts-tanstack's renderer-keys-are-registered-views.test.ts for why a dependency
// edge to @metaobjectsdev/react is not the answer.
describe("imageCell", () => {
  const adapter: ImageUploadAdapter = {
    upload: async () => ({ key: "unused" }),
    imageUrl: (key) => `https://cdn.example.com/${key}`,
  };
  const props = (out: unknown) =>
    (out as { props?: Record<string, unknown> } | null)?.props;

  test("renders an <img> whose src the adapter resolved from the stored key", () => {
    const p = props(imageCell(adapter)(ctx("avatars/abc123")));
    expect(p?.src).toBe("https://cdn.example.com/avatars/abc123");
  });

  test("an absent value renders nothing, never an empty <img>", () => {
    // An <img src=""> resolves to the PAGE url and re-requests it, so "" is not a
    // harmless placeholder — there is no empty-src fallback to fall back to.
    expect(imageCell(adapter)(ctx(null))).toBe("");
    expect(imageCell(adapter)(ctx(""))).toBe("");
  });

  test("an adapter that throws on the key renders the key as the text it is", () => {
    const throwing: ImageUploadAdapter = {
      upload: async () => ({ key: "unused" }),
      imageUrl: () => { throw new Error("unresolvable key"); },
    };
    expect(imageCell(throwing)(ctx("orphaned-key"))).toBe("orphaned-key");
  });

  test("size and alt are overridable, and default to a square decorative thumbnail", () => {
    // alt defaults to "" because the row around the cell already carries the meaning;
    // announcing a storage key would be worse than announcing nothing.
    const d = props(imageCell(adapter)(ctx("k")));
    expect(d?.width).toBe(32);
    expect(d?.height).toBe(32);
    expect(d?.alt).toBe("");
    const o = props(imageCell(adapter, { size: 64, alt: "Cover art" })(ctx("k")));
    expect(o?.width).toBe(64);
    expect(o?.alt).toBe("Cover art");
  });

  test("it is NOT a default renderer — the adapter has to come from the app", () => {
    // The converse arm of codegen-ts-tanstack's gate ("no exemption outlives the gap it
    // explains") goes red if `image` becomes a key here, and correctly so: a keyed
    // default would have no adapter to call.
    expect(defaultCellRenderers.image).toBeUndefined();
  });

  test("it reaches the `image` key through CellRendererProvider", () => {
    const { result } = renderHook(() => useCellRenderers(), {
      wrapper: ({ children }) => (
        <CellRendererProvider value={{ image: imageCell(adapter) }}>{children}</CellRendererProvider>
      ),
    });
    expect(props(result.current.image!(ctx("k")))?.src).toBe("https://cdn.example.com/k");
  });
});
