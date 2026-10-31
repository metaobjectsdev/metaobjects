-- The database the application already runs: what `drizzle-kit generate` wrote for src/db/schema.ts.
CREATE TABLE "customers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" varchar(254) NOT NULL,
  "display_name" varchar(120) NOT NULL,
  "loyalty_points" integer DEFAULT 0 NOT NULL,
  "marketing_opt_in" boolean DEFAULT false NOT NULL,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "customers_email_unique" UNIQUE ("email")
);

CREATE TABLE "orders" (
  "id" bigserial PRIMARY KEY NOT NULL,
  "customer_id" uuid NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "total" numeric(12, 2) NOT NULL,
  "shipping_address" jsonb,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  "placed_on" date NOT NULL,
  CONSTRAINT "orders_status_chk" CHECK (status IN ('pending', 'paid', 'shipped'))
);

ALTER TABLE "orders" ADD CONSTRAINT "orders_customer_id_customers_id_fk"
  FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
