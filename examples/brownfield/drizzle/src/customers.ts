import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { type Customer, customers, type NewCustomer } from "./db/schema.js";

type Db = PgDatabase<PgQueryResultHKT>;

export async function findByEmail(db: Db, email: string): Promise<Customer | undefined> {
  const [row] = await db.select().from(customers).where(eq(customers.email, email));
  return row;
}

export async function register(db: Db, input: NewCustomer): Promise<void> {
  await db.insert(customers).values(input);
}

export function memberSince(customer: Customer): number {
  return customer.createdAt.getFullYear();
}
