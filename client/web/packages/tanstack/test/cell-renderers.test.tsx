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
