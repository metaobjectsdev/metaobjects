import { describe, test, expect } from "bun:test";
import { resolve } from "node:path";
import {
  angularServiceFile,
  angularFormFile,
  angularGridFile,
  barrel,
} from "../src/index.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";
import type { GenContext } from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader } from "@metaobjectsdev/metadata";
import { FileSource } from "@metaobjectsdev/metadata/core";

const FIXTURE = resolve(import.meta.dir, "fixtures", "author-entity.json");

async function ctxFor(filter?: (e: any) => boolean): Promise<GenContext> {
  const { root } = await new MetaDataLoader().load([new FileSource(FIXTURE)]);
  const entities = root.objects();
  const renderContext = makeRenderContext({
    dialect: "sqlite",
    loadedRoot: root,
    outDir: "/tmp",
    dbImport: "../db",
    extStyle: "none",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
  return {
    entities,
    loadedRoot: root,
    matches: filter ?? (() => true),
    config: { outDir: "/tmp", extStyle: "none", dbImport: "../db", dialect: "sqlite" },
    renderContext,
    warn: () => {},
  };
}

describe("angularServiceFile() factory", () => {
  test("returns a Generator named 'angular-service'", () => {
    expect(angularServiceFile().name).toBe("angular-service");
  });

  test("accepts target opt", () => {
    expect(angularServiceFile({ target: "web" }).target).toBe("web");
  });

  test("emits Author.service.ts with @Injectable + CRUD methods", async () => {
    const gen = angularServiceFile();
    const ctx = await ctxFor((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files.length).toBe(1);
    const file = files[0]!;
    expect(file.path).toBe("Author.service.ts");
    expect(file.content).toContain("AuthorService");
    expect(file.content).toContain("@Injectable");
    expect(file.content).toContain('providedIn: "root"');
    expect(file.content).toContain("list(");
    expect(file.content).toContain("get(");
    expect(file.content).toContain("create(");
    expect(file.content).toContain("update(");
    expect(file.content).toContain("delete(");
    expect(file.content).toContain("EntityFetcherToken");
    expect(file.content).toContain("@metaobjectsdev/angular");
  });
});

describe("angularFormFile() factory", () => {
  test("returns a Generator named 'angular-form'", () => {
    expect(angularFormFile().name).toBe("angular-form");
  });

  test("emits Author.form.component.ts with reactive form + standalone Component", async () => {
    const gen = angularFormFile();
    const ctx = await ctxFor((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files.length).toBe(1);
    const file = files[0]!;
    expect(file.path).toBe("Author.form.component.ts");
    expect(file.content).toContain("AuthorFormComponent");
    expect(file.content).toContain("@Component");
    expect(file.content).toContain("standalone: true");
    expect(file.content).toContain("ReactiveFormsModule");
    // The primary-key 'id' field should NOT appear in the form group.
    expect(file.content).not.toMatch(/^\s+id:\s*\[/m);
    // Visible string + boolean fields appear:
    expect(file.content).toContain("name:");
    expect(file.content).toContain("bio:");
    expect(file.content).toContain("active:");
    // Validators wired for required + maxLength:
    expect(file.content).toContain("Validators.required");
    expect(file.content).toContain("Validators.maxLength(200)");
  });
});

describe("angularGridFile() factory", () => {
  test("returns a Generator named 'angular-grid'", () => {
    expect(angularGridFile().name).toBe("angular-grid");
  });

  test("emits Author.grid.component.ts with columns + gridConfig", async () => {
    const gen = angularGridFile();
    const ctx = await ctxFor((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files.length).toBe(1);
    const file = files[0]!;
    expect(file.path).toBe("Author.grid.component.ts");
    expect(file.content).toContain("AuthorGridComponent");
    expect(file.content).toContain("EntityGridComponent");
    expect(file.content).toContain('id: "name"');
    expect(file.content).toContain('id: "bio"');
    expect(file.content).toContain('id: "active"');
    expect(file.content).toContain("pageSize: 25");
    expect(file.content).toContain('field: "name"');
    expect(file.content).toContain('order: "asc"');
  });

  test("entity with no dataGrid layout — factory filter rejects", () => {
    const gen = angularGridFile();
    const fake = {
      name: "X",
      ownAttr: () => undefined,
      layouts: () => [] as any[],
    } as any;
    expect(gen.filter?.(fake)).toBe(false);
  });
});

describe("barrel() factory", () => {
  test("returns a Generator named 'angular-barrel'", () => {
    expect(barrel().name).toBe("angular-barrel");
  });

  test("emits index.ts re-exporting all per-entity Angular files", async () => {
    const gen = barrel();
    const ctx = await ctxFor((e) => gen.filter?.(e) ?? true);
    const files = await gen.generate(ctx);
    expect(files.length).toBe(1);
    const file = files[0]!;
    expect(file.path).toBe("index.ts");
    expect(file.content).toContain('./Author.service');
    expect(file.content).toContain('./Author.form.component');
    expect(file.content).toContain('./Author.grid.component');
  });
});
