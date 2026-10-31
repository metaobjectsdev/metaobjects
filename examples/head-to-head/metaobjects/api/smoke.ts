// End-to-end probe, identical in both setups: create a customer through the API,
// read it back, print its id.
import { buildApp } from "./src/app";

const app = buildApp(process.env.DATABASE_URL ?? "");
const created = await app.inject({
  method: "POST",
  url: "/customers",
  payload: { email: "ada@example.test", name: "Ada Lovelace", plan: "pro" },
});
if (created.statusCode !== 201) {
  throw new Error(`POST /customers -> ${created.statusCode} ${created.body}`);
}
const { id } = created.json<{ id: number }>();
const read = await app.inject({ method: "GET", url: `/customers/${id}` });
if (read.statusCode !== 200 || read.json<{ email: string }>().email !== "ada@example.test") {
  throw new Error(`GET /customers/${id} -> ${read.statusCode} ${read.body}`);
}
await app.close();
console.log(id);
