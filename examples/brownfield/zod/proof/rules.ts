// tsc cannot see .min(), .max() or .email(): they do not change the type. Zod can: compare the
// JSON Schema each validator describes, on input and on output. Run this with your test runner,
// or with node or bun.
import assert from "node:assert/strict";
import { z } from "zod";
import { Address, CreateCustomer } from "../src/api/schemas.js";
import { AddressInsertSchema } from "../src/generated/Address.js";
import { CreateCustomerInsertSchema } from "../src/generated/CreateCustomer.js";

// `required` follows the order of the fields, which does not change what a schema accepts.
const rules = (schema: z.ZodType, io: "input" | "output") =>
  JSON.parse(
    JSON.stringify(z.toJSONSchema(schema, { io, unrepresentable: "any" }), (key, value) =>
      key === "required" && Array.isArray(value) ? [...value].sort() : value,
    ),
  );

for (const io of ["input", "output"] as const) {
  assert.deepEqual(rules(Address, io), rules(AddressInsertSchema, io));
  assert.deepEqual(rules(CreateCustomer, io), rules(CreateCustomerInsertSchema, io));
}
