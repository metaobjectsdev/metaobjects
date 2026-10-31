// tsc is the check: it fails this file, naming the field, when a pair stops matching.
// Compare input and output: a default or a transform changes one without the other.
// Delete it once the last call site has moved.
import type { z } from "zod";
import type { Address, CreateCustomer } from "../src/api/schemas.js";
import type { AddressInsertSchema } from "../src/generated/Address.js";
import type { CreateCustomerInsertSchema } from "../src/generated/CreateCustomer.js";
import type { Differs, Same } from "./differs.js";

export type Proof = [
  Same<Differs<z.input<typeof Address>, z.input<typeof AddressInsertSchema>>>,
  Same<Differs<z.output<typeof Address>, z.output<typeof AddressInsertSchema>>>,
  Same<Differs<z.input<typeof CreateCustomer>, z.input<typeof CreateCustomerInsertSchema>>>,
  Same<Differs<z.output<typeof CreateCustomer>, z.output<typeof CreateCustomerInsertSchema>>>,
];
