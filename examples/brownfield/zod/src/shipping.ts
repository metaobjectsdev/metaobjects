import { Address } from "./api/schemas.js";

export function parseAddress(body: unknown): Address {
  return Address.parse(body);
}

export function label(address: Address): string {
  return `${address.line1}, ${address.city}`;
}
