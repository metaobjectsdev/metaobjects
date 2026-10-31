import { eq } from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";
import { type NewOrder, type Order, orders } from "./db/schema.js";

type Db = PgDatabase<PgQueryResultHKT>;

export async function ordersFor(db: Db, customerId: string): Promise<Order[]> {
  return db.select().from(orders).where(eq(orders.customerId, customerId));
}

export async function place(db: Db, input: NewOrder): Promise<void> {
  await db.insert(orders).values(input);
}

export function shipTo(order: Order): string {
  return order.shippingAddress?.city ?? "collection";
}
