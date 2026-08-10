import "./setup.js";
import { describe, test, expect } from "bun:test";
import { Injector } from "@angular/core";
import {
  EntityFetcherToken,
  provideEntityFetcher,
  CellRendererRegistry,
  CurrencyInputComponent,
  formatCurrency,
} from "../src/index.js";
import type { EntityFetcher } from "../src/index.js";

describe("EntityFetcherToken — DI smoke", () => {
  test("provideEntityFetcher supplies the fetcher via Injector", async () => {
    const fakeFetcher: EntityFetcher = async <T>(_path: string): Promise<T> => {
      return [] as unknown as T;
    };
    const injector = Injector.create({
      providers: [provideEntityFetcher(fakeFetcher)],
    });
    const resolved = injector.get(EntityFetcherToken);
    expect(typeof resolved).toBe("function");
    const result = await resolved<unknown[]>("/api/author");
    expect(Array.isArray(result)).toBe(true);
    expect((result as unknown[]).length).toBe(0);
  });

  test("EntityFetcherToken throws helpful error when not provided", () => {
    const injector = Injector.create({ providers: [] });
    // The token declares no factory, so Angular's stock NullInjectorError fires;
    // its message carries the token description ("metaobjects.EntityFetcher").
    expect(() => injector.get(EntityFetcherToken)).toThrow(/No provider for.*EntityFetcher/);
  });
});

describe("CellRendererRegistry — DI smoke", () => {
  test("registry registers + resolves a component class", () => {
    const registry = new CellRendererRegistry();
    class FakeRenderer {
      value: unknown = null;
    }
    expect(registry.resolve("currency")).toBeNull();
    registry.register("currency", FakeRenderer as never);
    expect(registry.resolve("currency")).toBe(FakeRenderer as never);
    registry.clear();
    expect(registry.resolve("currency")).toBeNull();
  });
});

describe("CurrencyInputComponent — formatting logic", () => {
  // Constructing the component directly (no TestBed) verifies the
  // signal-driven display logic without needing zone.js + browser platform.
  test("formats 12345 cents USD/en-US as $123.45", () => {
    expect(formatCurrency(12345, "USD", "en-US")).toBe("$123.45");
  });

  test("constructor + writeValue resyncs displayText to formatted value", () => {
    const c = new CurrencyInputComponent();
    c.currency = "USD";
    c.locale = "en-US";
    c.writeValue(12345);
    expect(c.displayText()).toBe("$123.45");
  });

  test("writeValue(0) resyncs displayText to $0.00", () => {
    const c = new CurrencyInputComponent();
    c.currency = "USD";
    c.locale = "en-US";
    c.writeValue(0);
    expect(c.displayText()).toBe("$0.00");
  });

  test("writeValue with non-finite falls back to 0", () => {
    const c = new CurrencyInputComponent();
    c.currency = "USD";
    c.locale = "en-US";
    c.writeValue(Number.NaN);
    expect(c.displayText()).toBe("$0.00");
  });

  test("onFocus strips symbol + grouping to plain decimal", () => {
    const c = new CurrencyInputComponent();
    c.currency = "USD";
    c.locale = "en-US";
    c.valueCents = 12345;
    c.writeValue(12345);
    c.onFocus();
    expect(c.displayText()).toBe("123.45");
  });

  test("onBlur with parseable input fires valueChange with cents", () => {
    const c = new CurrencyInputComponent();
    c.currency = "USD";
    c.locale = "en-US";
    let emitted: number | null = null;
    c.valueChange.subscribe((v) => (emitted = v));
    c.displayText.set("15.99");
    c.onBlur();
    expect(emitted!).toBe(1599);
    expect(c.displayText()).toBe("$15.99");
  });

  test("onBlur with empty + required marks invalid and does not emit", () => {
    const c = new CurrencyInputComponent();
    c.currency = "USD";
    c.locale = "en-US";
    c.required = true;
    c.valueCents = 1500;
    c.writeValue(1500);
    let emitted: number | null = null;
    c.valueChange.subscribe((v) => (emitted = v));
    c.displayText.set("");
    c.onBlur();
    expect(emitted).toBeNull();
    expect(c.isInvalid()).toBe(true);
    expect(c.displayText()).toBe("$15.00");
  });

  test("onBlur with empty + not required emits 0", () => {
    const c = new CurrencyInputComponent();
    c.currency = "USD";
    c.locale = "en-US";
    c.required = false;
    c.valueCents = 1500;
    c.writeValue(1500);
    let emitted: number | null = null;
    c.valueChange.subscribe((v) => (emitted = v));
    c.displayText.set("");
    c.onBlur();
    expect(emitted!).toBe(0);
    expect(c.displayText()).toBe("$0.00");
  });

  test("onBlur with unparseable input reverts to last valid format", () => {
    const c = new CurrencyInputComponent();
    c.currency = "USD";
    c.locale = "en-US";
    c.valueCents = 1500;
    c.writeValue(1500);
    let emitted: number | null = null;
    c.valueChange.subscribe((v) => (emitted = v));
    c.displayText.set("abc");
    c.onBlur();
    expect(emitted).toBeNull();
    expect(c.displayText()).toBe("$15.00");
  });

  test("respects locale prop — de-DE EUR formatting", () => {
    const c = new CurrencyInputComponent();
    c.currency = "EUR";
    c.locale = "de-DE";
    c.writeValue(1500);
    // German EUR format: "15,00 €" or "15,00 €" (with NBSP)
    expect(c.displayText()).toMatch(/15,00/);
  });
});
