// The GENERATED service (ADR-0067 layer 4) on the two SQLite drivers that cannot run Drizzle's
// async transaction:
//
//   - bun:sqlite, a SYNC driver. Drizzle's `transaction()` there commits when its callback returns,
//     so before the runtime drove the transaction itself a hook's refusal after the insert answered
//     409 over a row that stayed. The default service must hold its rollback guarantee here.
//   - Cloudflare D1 (Miniflare's local runtime), which holds no transaction across application code:
//     it refuses `BEGIN`. The default service fails there on every write; the service generated with
//     `interactiveTransactions: false` (ADR-0067 §4) runs, with no hooks, no event hook and no
//     transaction, its transition still guarded by the one UPDATE.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle as drizzleBunSqlite } from "drizzle-orm/bun-sqlite";
import { drizzle as drizzleD1 } from "drizzle-orm/d1";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runGen, defineConfig } from "@metaobjectsdev/codegen-ts";
import { contractTypes, entityFile, serviceFile } from "@metaobjectsdev/codegen-ts/generators";
import { DEFAULT_PHYSICAL_NAMING } from "@metaobjectsdev/metadata";
import { loadMetadataFile } from "../src/load-metadata.ts";
import { startLocalD1, type LocalD1 } from "../src/query-scenario-d1.ts";

const MODEL = {
  "metadata.root": {
    package: "acme::notes",
    children: [
      {
        "object.entity": {
          name: "Note",
          children: [
            { "source.rdb": { "@table": "notes" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.string": { name: "title", "@maxLength": 80, "@required": true } },
            {
              "field.enum": {
                name: "status",
                "@values": ["draft", "published"],
                "@default": "draft",
                children: [{ "transition.action": { name: "publish", "@from": ["draft"], "@to": "published", "@public": true } }],
              },
            },
          ],
        },
      },
    ],
  },
};

const DDL = "CREATE TABLE notes (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, status TEXT DEFAULT 'draft')";

interface Result {
  ok: boolean;
  status?: number;
  error?: { error: string };
  value?: unknown;
}
interface Ctx {
  refuse(code: string): never;
}
interface NotesService {
  createNote(input: { title: string }): Promise<Result>;
  updateNote(id: number, patch: { title?: string; status?: string }): Promise<Result>;
  deleteNote(id: number): Promise<Result>;
  publishNote(id: number): Promise<Result>;
  listNotes(query: Record<string, unknown>): Promise<Result>;
}
type Factory = (deps: Record<string, unknown>) => NotesService;

const here = dirname(fileURLToPath(import.meta.url));
let tmp: string;

/** Generate the model's service for SQLite into its own folder and import its factory. */
async function generate(folder: string, interactiveTransactions?: boolean): Promise<Factory> {
  const out = join(tmp, folder);
  const root = await loadMetadataFile(join(tmp, "meta.json"));
  root.physicalNaming = DEFAULT_PHYSICAL_NAMING;
  const r = await runGen({
    config: defineConfig({
      outDir: out,
      extStyle: "none",
      dialect: "sqlite",
      generators: [
        entityFile(),
        contractTypes(),
        serviceFile(interactiveTransactions === undefined ? undefined : { interactiveTransactions }),
      ],
    }),
    metadata: root,
  });
  if (r.warnings.length > 0) throw new Error(`codegen produced warnings: ${r.warnings.join("; ")}`);
  const mod = (await import(pathToFileURL(join(out, "acme/notes/service/index.ts")).href)) as { createNotesService: Factory };
  return mod.createNotesService;
}

beforeAll(() => {
  const genTmpRoot = join(here, "..", ".gen-tmp");
  mkdirSync(genTmpRoot, { recursive: true });
  tmp = mkdtempSync(join(genTmpRoot, "service-sqlite-drivers-"));
  writeFileSync(join(tmp, "meta.json"), JSON.stringify(MODEL), "utf8");
});

afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const refuseTitle = { afterCreateNote: (row: { title: string }, ctx: Ctx) => { if (row.title === "REFUSE") ctx.refuse("title_refused"); } };

describe("the generated service on a sync SQLite driver (bun:sqlite)", () => {
  let sqlite: Database;
  let service: NotesService;
  const titles = (): string[] => (sqlite.query("SELECT title FROM notes ORDER BY id").all() as { title: string }[]).map((r) => r.title);

  beforeAll(async () => {
    sqlite = new Database(":memory:");
    sqlite.run(DDL);
    const create = await generate("bun-sqlite");
    service = create({ db: drizzleBunSqlite(sqlite), hooks: refuseTitle });
  });
  afterAll(() => sqlite.close());

  test("a create commits, starting in the initial state", async () => {
    const r = await service.createNote({ title: "first" });
    expect(r).toMatchObject({ ok: true, value: { id: 1, title: "first", status: "draft" } });
    expect(titles()).toEqual(["first"]);
  });

  test("a hook that refuses after the insert undoes it", async () => {
    const r = await service.createNote({ title: "REFUSE" });
    expect(r).toEqual({ ok: false, status: 409, error: { error: "title_refused" } });
    expect(titles()).toEqual(["first"]);
  });

  test("a transition moves the row once, and a second move is invalid_transition", async () => {
    expect(await service.publishNote(1)).toMatchObject({ ok: true, value: { id: 1, status: "published" } });
    expect(await service.publishNote(1)).toEqual({ ok: false, status: 409, error: { error: "invalid_transition" } });
  });

  test("operations running at once each keep their own guarantee", async () => {
    const [kept, refused] = await Promise.all([service.createNote({ title: "kept" }), service.createNote({ title: "REFUSE" })]);
    expect(kept.ok).toBe(true);
    expect(refused).toMatchObject({ ok: false, status: 409 });
    expect(titles()).toEqual(["first", "kept"]);
  });
});

describe("the generated service on Cloudflare D1 (Miniflare)", () => {
  let local: LocalD1;
  let service: NotesService;
  const titles = async (): Promise<string[]> =>
    ((await local.d1.prepare("SELECT title FROM notes ORDER BY id").bind().all()) as { results: { title: string }[] }).results.map((r) => r.title);

  beforeAll(async () => {
    local = await startLocalD1();
    await local.d1.exec(DDL);
    const create = await generate("d1", false);
    service = create({ db: drizzleD1(local.d1 as never) });
  }, 60_000);
  afterAll(async () => local.dispose());

  test("the default service cannot run there: D1 refuses the transaction it opens", async () => {
    const create = await generate("d1-default");
    const failing = create({ db: drizzleD1(local.d1 as never) });
    const quiet = console.error;
    console.error = () => {};
    try {
      await expect(failing.createNote({ title: "never" })).rejects.toThrow();
    } finally {
      console.error = quiet;
    }
    expect(await titles()).toEqual([]);
  });

  test("with interactiveTransactions: false every derived write runs", async () => {
    expect(await service.createNote({ title: "first" })).toMatchObject({ ok: true, value: { id: 1, title: "first", status: "draft" } });
    expect(await service.updateNote(1, { title: "renamed" })).toMatchObject({ ok: true, value: { id: 1, title: "renamed" } });
    expect(await service.createNote({ title: "second" })).toMatchObject({ ok: true, value: { id: 2 } });
    expect(await service.deleteNote(2)).toEqual({ ok: true, value: undefined });
    expect(await titles()).toEqual(["renamed"]);
  });

  test("the rules still hold: the lifecycle field is state_managed, and the transition is guarded", async () => {
    expect(await service.updateNote(1, { status: "published" })).toEqual({ ok: false, status: 409, error: { error: "state_managed" } });
    expect(await service.publishNote(1)).toMatchObject({ ok: true, value: { status: "published" } });
    expect(await service.publishNote(1)).toEqual({ ok: false, status: 409, error: { error: "invalid_transition" } });
    expect(await service.publishNote(99)).toEqual({ ok: false, status: 404, error: { error: "not_found" } });
  });
});
