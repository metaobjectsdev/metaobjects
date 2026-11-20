import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/server/app";
import { businessRules } from "../src/server/business-rules";
import { openRuntime, type OpenRuntimeOptions, type Runtime } from "../src/server/runtime";
import { seed } from "../src/server/seed";

/** The example project itself: its metadata and its `.metaobjects/config.json`. */
export const PROJECT_DIR = resolve(import.meta.dir, "..");
const MODEL_FILE = join("metaobjects", "meta.workshop.yaml");
const CONFIG_FILE = join(".metaobjects", "config.json");

export interface Demo {
  readonly runtime: Runtime;
  readonly app: FastifyInstance;
  get(url: string): Promise<{ status: number; body: unknown }>;
  send(method: "POST" | "PATCH" | "PUT" | "DELETE", url: string, payload?: unknown): Promise<{ status: number; body: unknown }>;
  close(): Promise<void>;
}

function parse(text: string): unknown {
  return text === "" ? undefined : JSON.parse(text);
}

/** The seeded demo app on a throwaway database, driven in-process (no port is opened). */
export async function openDemo(options: Partial<OpenRuntimeOptions> = {}): Promise<Demo> {
  const runtime = await openRuntime({ projectDir: PROJECT_DIR, ...options });
  await seed(runtime.current().om);
  const app = buildApp({ runtime, rules: businessRules });
  return {
    runtime,
    app,
    async get(url) {
      const res = await app.inject({ method: "GET", url });
      return { status: res.statusCode, body: parse(res.body) };
    },
    async send(method, url, payload) {
      const res = await app.inject({ method, url, ...(payload !== undefined ? { payload: payload as object } : {}) });
      return { status: res.statusCode, body: parse(res.body) };
    },
    async close() {
      await app.close();
      await runtime.close();
    },
  };
}

/** A scratch copy of the project's metadata and config, which a test may then edit. */
export interface ProjectCopy {
  readonly dir: string;
  /** Rewrite the model file. Throws when `find` is not in it, so a stale test fails loudly. */
  editModel(find: string, replaceWith: string): void;
  appendModel(yaml: string): void;
  editConfig(edit: (config: Record<string, unknown>) => void): void;
  remove(): void;
}

export function copyProject(): ProjectCopy {
  const dir = mkdtempSync(join(process.env["DEV_SCRATCH"] ?? tmpdir(), "dynamic-grid-project-"));
  cpSync(join(PROJECT_DIR, "metaobjects"), join(dir, "metaobjects"), { recursive: true });
  cpSync(join(PROJECT_DIR, CONFIG_FILE), join(dir, CONFIG_FILE));
  const model = join(dir, MODEL_FILE);
  const config = join(dir, CONFIG_FILE);
  return {
    dir,
    editModel(find, replaceWith) {
      const text = readFileSync(model, "utf8");
      if (!text.includes(find)) throw new Error(`the model has no "${find}" to edit`);
      writeFileSync(model, text.replace(find, replaceWith));
    },
    appendModel(yaml) {
      writeFileSync(model, `${readFileSync(model, "utf8").trimEnd()}\n${yaml}`);
    },
    editConfig(edit) {
      const parsed = JSON.parse(readFileSync(config, "utf8")) as Record<string, unknown>;
      edit(parsed);
      writeFileSync(config, JSON.stringify(parsed, null, 2));
    },
    remove() {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
