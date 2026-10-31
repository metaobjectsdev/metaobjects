// tsc is the check: it fails this file, naming the field, when a pair stops matching.
// Delete it once the last call site has moved.
import type { Customer, NewCustomer, NewOrder, Order, ShippingAddress } from "../src/db/schema.js";
import type { Customer as GeneratedCustomer, CustomerInsert } from "../src/generated/Customer.js";
import type { Order as GeneratedOrder, OrderInsert } from "../src/generated/Order.js";
import type { ShippingAddress as GeneratedShippingAddress } from "../src/generated/ShippingAddress.js";
import type { Differs, Same } from "./differs.js";

export type Proof = [
  Same<Differs<Customer, GeneratedCustomer>>,
  Same<Differs<NewCustomer, CustomerInsert>>,
  Same<Differs<Order, GeneratedOrder>>,
  Same<Differs<NewOrder, OrderInsert>>,
  Same<Differs<ShippingAddress, GeneratedShippingAddress>>,
];
