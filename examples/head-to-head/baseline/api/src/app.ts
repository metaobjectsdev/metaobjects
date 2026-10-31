import Fastify from "fastify";
import pg from "pg";
import type { components, operations } from "../../generated/api";

type Customer = components["schemas"]["Customer"];
type CreateCustomer = components["schemas"]["CreateCustomer"];
type ListQuery = NonNullable<operations["Customers_list"]["parameters"]["query"]>;

const COLUMNS = `id, email, name, plan, created_at AS "createdAt"`;

export function buildApp(databaseUrl: string) {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const app = Fastify();
  app.addHook("onClose", async () => pool.end());

  app.get<{ Querystring: ListQuery }>("/customers", async (req) => {
    const { email } = req.query;
    const sql = `SELECT ${COLUMNS} FROM customers WHERE ($1::text IS NULL OR email = $1) ORDER BY id`;
    return (await pool.query<Customer>(sql, [email ?? null])).rows;
  });

  app.get<{ Params: { id: string } }>("/customers/:id", async (req, reply) => {
    const { rows } = await pool.query<Customer>(
      `SELECT ${COLUMNS} FROM customers WHERE id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) return reply.code(404).send();
    return rows[0];
  });

  app.post<{ Body: CreateCustomer }>("/customers", async (req, reply) => {
    const { email, name, plan } = req.body;
    const { rows } = await pool.query<Customer>(
      `INSERT INTO customers (email, name, plan) VALUES ($1, $2, $3) RETURNING ${COLUMNS}`,
      [email, name ?? null, plan ?? "free"],
    );
    return reply.code(201).send(rows[0]);
  });

  return app;
}
