// tsc cannot see .min(), .max() or .email(): they do not change the type. Zod can: compare the
// JSON Schema each validator describes. Run this with your test runner, or with node or bun.
import assert from "node:assert/strict";
import { z } from "zod";
import { Address, CreateCustomer } from "../src/api/schemas.js";
import { AddressInsertSchema } from "../src/generated/Address.js";
import { CreateCustomerInsertSchema } from "../src/generated/CreateCustomer.js";

const rules = (schema: z.ZodType) => z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });

assert.deepEqual(rules(Address), rules(AddressInsertSchema));
assert.deepEqual(rules(CreateCustomer), rules(CreateCustomerInsertSchema));
