import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import Fastify from "fastify";
import pg from "pg";
import { CustomerInsertSchema, customers } from "./generated/Customer";

export function buildApp(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const db = drizzle(pool);
  const app = Fastify();
  app.addHook("onClose", async () => pool.end());

  app.get<{ Querystring: { email?: string } }>("/customers", async (req) => {
    const { email } = req.query;
    const query = db.select().from(customers).orderBy(customers.id);
    return email === undefined ? query : query.where(eq(customers.email, email));
  });

  app.get<{ Params: { id: string } }>("/customers/:id", async (req, reply) => {
    const rows = await db.select().from(customers).where(eq(customers.id, Number(req.params.id)));
    if (rows.length === 0) return reply.code(404).send();
    return rows[0];
  });

  app.post("/customers", async (req, reply) => {
    const parsed = CustomerInsertSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request", issues: parsed.error.issues });
    const [created] = await db.insert(customers).values(parsed.data).returning();
    return reply.code(201).send(created);
  });

  return app;
}
