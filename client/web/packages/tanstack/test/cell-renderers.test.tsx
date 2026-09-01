import { describe, test, expect } from "bun:test";
import "./setup.js";
import { renderHook } from "@testing-library/react";
import {
  defaultCellRenderers,
  CellRendererProvider,
  useCellRenderers,
} from "../src/index.js";

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
