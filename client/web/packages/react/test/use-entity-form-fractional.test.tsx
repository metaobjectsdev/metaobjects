import "./setup.js";
import { describe, test, expect, afterEach } from "bun:test";
import { render, cleanup } from "@testing-library/react";
import React from "react";
import { z } from "zod";
import { useEntityForm } from "../src/use-entity-form.js";

afterEach(() => { cleanup(); });

// What `<Entity>.meta.ts` carries for a double, a decimal and an int field.
const Item = {
  $entity: "Item",
  $table: "items",
  $path: "/items",
  weight: { name: "weight", label: "Weight", view: "number", htmlType: "number", step: "any" },
  price: { name: "price", label: "Price", view: "number", htmlType: "text", inputMode: "decimal" },
  qty: { name: "qty", label: "Qty", view: "number", htmlType: "number" },
} as const;

function Form() {
  const form = useEntityForm(Item, z.object({ weight: z.string(), price: z.string(), qty: z.string() }));
  return (
    <form>
      <input data-testid="weight" {...form.input.weight} />
      <input data-testid="price" {...form.input.price} />
      <input data-testid="qty" {...form.input.qty} />
    </form>
  );
}

describe("useEntityForm — fractional inputs", () => {
  test("a double's input has step=any, so the browser accepts 12.5", () => {
    const { getByTestId } = render(<Form />);
    const weight = getByTestId("weight") as HTMLInputElement;
    expect(weight.type).toBe("number");
    expect(weight.getAttribute("step")).toBe("any");
    weight.value = "12.5";
    expect(weight.validity.stepMismatch).toBe(false);
  });

  test("an int keeps the default step, so 12.5 is still refused", () => {
    const { getByTestId } = render(<Form />);
    const qty = getByTestId("qty") as HTMLInputElement;
    expect(qty.hasAttribute("step")).toBe(false);
    qty.value = "12.5";
    expect(qty.validity.stepMismatch).toBe(true);
  });

  test("a decimal is a text input with a decimal keyboard, not a number input", () => {
    const { getByTestId } = render(<Form />);
    const price = getByTestId("price") as HTMLInputElement;
    expect(price.type).toBe("text");
    expect(price.getAttribute("inputmode")).toBe("decimal");
    expect(price.hasAttribute("step")).toBe(false);
  });
});
