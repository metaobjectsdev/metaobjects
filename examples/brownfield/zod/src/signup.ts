import { CreateCustomer } from "./api/schemas.js";

export function parseSignup(body: unknown): CreateCustomer {
  return CreateCustomer.parse(body);
}

export function seatsFor(customer: CreateCustomer): number {
  return customer.seats ?? 1;
}
