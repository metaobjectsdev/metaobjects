import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const customers = pgTable("customers", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: varchar("email", { length: 254 }).notNull().unique(),
  displayName: varchar("display_name", { length: 120 }).notNull(),
  loyaltyPoints: integer("loyalty_points").notNull().default(0),
  marketingOptIn: boolean("marketing_opt_in").notNull().default(false),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Customer = typeof customers.$inferSelect;
export type NewCustomer = typeof customers.$inferInsert;

export type ShippingAddress = { line1: string; city: string; postcode?: string };

export const orders = pgTable(
  "orders",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    customerId: uuid("customer_id")
      .notNull()
      .references(() => customers.id),
    status: text("status", { enum: ["pending", "paid", "shipped"] })
      .notNull()
      .default("pending"),
    total: numeric("total", { precision: 12, scale: 2 }).notNull(),
    shippingAddress: jsonb("shipping_address").$type<ShippingAddress>(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    placedOn: date("placed_on").notNull(),
  },
  () => [check("orders_status_chk", sql`status IN ('pending', 'paid', 'shipped')`)],
);

export type Order = typeof orders.$inferSelect;
export type NewOrder = typeof orders.$inferInsert;
