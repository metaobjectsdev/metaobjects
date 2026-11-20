/**
 * The browser bundle of `src/client/`, built in memory when the dev server starts.
 */
import { join } from "node:path";

const CLIENT_DIR = join(import.meta.dir, "..", "client");

/** The client as one JavaScript module, or a thrown error listing what did not bundle. */
export async function buildClientBundle(): Promise<string> {
  const built = await Bun.build({
    entrypoints: [join(CLIENT_DIR, "main.tsx")],
    target: "browser",
    // The workspace packages are read from their TypeScript source (their `bun` export
    // condition), so the example runs from a fresh checkout with nothing built first.
    conditions: ["bun"],
    define: { "process.env.NODE_ENV": JSON.stringify("development") },
  });
  const [script] = built.outputs;
  if (!built.success || script === undefined) {
    throw new Error(`the client did not bundle:\n${built.logs.map(String).join("\n")}`);
  }
  return script.text();
}

/** The two static files served beside the bundle. */
export const CLIENT_INDEX_HTML = join(CLIENT_DIR, "index.html");
export const CLIENT_STYLESHEET = join(CLIENT_DIR, "app.css");
