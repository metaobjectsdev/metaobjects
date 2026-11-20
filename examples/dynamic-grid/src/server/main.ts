/**
 * The dev server: `bun run dev`.
 *
 * It loads the metadata, creates a throwaway SQLite database for it, seeds a few rows,
 * serves the API and the page, and watches the metadata. Save a metadata file and the
 * model is loaded again in place: the next request, and the open page, use the new one.
 */
import { watch, type FSWatcher } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DEFAULT_METAOBJECTS_DIR, resolveCollection } from "@metaobjectsdev/sdk";
import { API_PREFIX, buildApp } from "./app";
import { businessRules } from "./business-rules";
import { buildClientBundle, CLIENT_INDEX_HTML, CLIENT_STYLESHEET } from "./client-bundle";
import { openRuntime } from "./runtime";
import { seed } from "./seed";

const PROJECT_DIR = resolve(import.meta.dir, "..", "..");
const DEFAULT_PORT = 4310;
/** An editor saves in several writes; wait for them to stop before loading. */
const RELOAD_DELAY_MS = 150;

function listenPort(): number {
  const raw = process.env["PORT"];
  if (raw === undefined || raw === "") return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0) throw new Error(`PORT must be a port number, got "${raw}"`);
  return port;
}

const runtime = await openRuntime({ projectDir: PROJECT_DIR });
await seed(runtime.current().om);
const app = buildApp({ runtime, rules: businessRules });

const bundle = await buildClientBundle();
app.get("/", async (_req, reply) => reply.type("text/html; charset=utf-8").send(await readFile(CLIENT_INDEX_HTML, "utf8")));
app.get("/app.css", async (_req, reply) => reply.type("text/css; charset=utf-8").send(await readFile(CLIENT_STYLESHEET, "utf8")));
app.get("/app.js", async (_req, reply) => reply.type("text/javascript; charset=utf-8").send(bundle));

// Where this project's metadata lives is the collection's answer, not a directory name
// assumed here. The project config is watched too: `api.pagination` is read from it.
const collection = await resolveCollection(PROJECT_DIR);
const watched = [...collection.sourceRoots, join(collection.configDir, DEFAULT_METAOBJECTS_DIR)];

let pending: ReturnType<typeof setTimeout> | undefined;
function reloadSoon(): void {
  clearTimeout(pending);
  pending = setTimeout(() => {
    runtime.reload().then(
      (model) => console.log(`model reloaded: revision ${model.revision}, ${model.served.size} entities`),
      // A file that does not load, or a change that would lose data, is refused. The
      // server keeps answering with the model it had.
      (err: unknown) => console.error(`reload refused, still serving revision ${runtime.current().revision}:\n${String(err)}`),
    );
  }, RELOAD_DELAY_MS);
}
const watchers: FSWatcher[] = watched.map((dir) => watch(dir, { recursive: true }, reloadSoon));

const address = await app.listen({ port: listenPort(), host: "127.0.0.1" });
console.log(`dynamic grid demo: ${address}  (API under ${address}${API_PREFIX}, model at ${address}${API_PREFIX}/_meta)`);
console.log(`watching ${watched.join(", ")}`);

async function shutdown(): Promise<void> {
  clearTimeout(pending);
  for (const watcher of watchers) watcher.close();
  await app.close();
  await runtime.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
