import "../setup.js";
import { describe, test, expect, afterEach } from "bun:test";
import { render, fireEvent, screen, cleanup } from "@testing-library/react";
import React from "react";
import { CurrencyInput } from "../../src/components/currency-input.js";

afterEach(() => { cleanup(); });

describe("CurrencyInput — render", () => {
  test("renders formatted dollars in input value initially", () => {
    render(<CurrencyInput value={1500} onChange={() => {}} currency="USD" locale="en-US" />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("$15.00");
  });

  test("renders 0 as $0.00", () => {
    render(<CurrencyInput value={0} onChange={() => {}} currency="USD" locale="en-US" />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("$0.00");
  });

  test("respects custom currency prop in initial display", () => {
    render(<CurrencyInput value={1500} onChange={() => {}} currency="EUR" locale="de-DE" />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    // German EUR format: "15,00 €" or similar
    expect(input.value).toMatch(/15,00/);
  });
});

describe("CurrencyInput — focus strips formatting", () => {
  test("focus strips symbol and grouping to raw decimal", () => {
    render(<CurrencyInput value={1500} onChange={() => {}} currency="USD" locale="en-US" />);
    const input = screen.getByRole("textbox") as HTMLInputElement;
    expect(input.value).toBe("$15.00");
    fireEvent.focus(input);
    expect(input.value).toBe("15.00");
  });
});

describe("CurrencyInput — blur emits cents", () => {
  test("typing 15.99 and blurring emits onChange(1599)", () => {
    let emitted: number | null = null;
    render(
      <CurrencyInput
        value={0}
        onChange={(cents) => { emitted = cents; }}
        currency="USD"
        locale="en-US"
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "15.99" } });
    fireEvent.blur(input);
    expect(emitted!).toBe(1599);
    expect(input.value).toBe("$15.99");
  });

  test("empty input + not required → emits 0 + shows $0.00", () => {
    let emitted: number | null = null;
    render(
      <CurrencyInput
        value={1500}
        onChange={(cents) => { emitted = cents; }}
        currency="USD"
        required={false}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(emitted!).toBe(0);
    expect(input.value).toBe("$0.00");
  });

  test("empty input + required → no emit, reverts to last value", () => {
    let emitted: number | null = null;
    render(
      <CurrencyInput
        value={1500}
        onChange={(cents) => { emitted = cents; }}
        currency="USD"
        required={true}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(emitted).toBeNull();
    expect(input.value).toBe("$15.00");
  });

  test("unparseable input → no emit, reverts to last formatted value", () => {
    let emitted: number | null = null;
    render(
      <CurrencyInput
        value={1500}
        onChange={(cents) => { emitted = cents; }}
        currency="USD"
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "abc" } });
    fireEvent.blur(input);
    expect(emitted).toBeNull();
    expect(input.value).toBe("$15.00");
  });
});

describe("CurrencyInput — external value prop update", () => {
  test("external value prop update re-syncs display", () => {
    const { rerender } = render(<CurrencyInput value={1500} onChange={() => {}} currency="USD" locale="en-US" />);
    // Initial display
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("$15.00");
    // External update
    rerender(<CurrencyInput value={2000} onChange={() => {}} currency="USD" locale="en-US" />);
    expect((screen.getByRole("textbox") as HTMLInputElement).value).toBe("$20.00");
  });
});

describe("CurrencyInput — parse round-trip via underlying helpers", () => {
  test("parseCurrency('15.99') round-trips with onChange", async () => {
    const { parseCurrency } = await import("@metaobjects/runtime-web");
    expect(parseCurrency("15.99", "USD", "en-US")).toBe(1599);
  });
});

describe("CurrencyInput — data-invalid attribute", () => {
  test("required + empty blur → sets data-invalid='true', no onChange", () => {
    let emitted: number | null = null;
    render(
      <CurrencyInput
        value={1500}
        onChange={(cents) => { emitted = cents; }}
        currency="USD"
        required={true}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.blur(input);
    expect(input.getAttribute("data-invalid")).toBe("true");
    expect(emitted).toBeNull();
  });

  test("required + valid input → no data-invalid attr", () => {
    render(
      <CurrencyInput
        value={0}
        onChange={() => {}}
        currency="USD"
        required={true}
      />,
    );
    const input = screen.getByRole("textbox") as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "15.99" } });
    fireEvent.blur(input);
    expect(input.getAttribute("data-invalid")).toBeNull();
  });
});
