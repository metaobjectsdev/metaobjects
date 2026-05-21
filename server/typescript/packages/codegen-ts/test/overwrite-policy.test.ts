import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideAndWrite } from "../src/overwrite-policy.js";
import { GENERATED_HEADER } from "../src/constants.js";

let tmp: string;
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "codegen-policy-")); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe("decideAndWrite", () => {
  test("NEW: writes when file doesn't exist", () => {
    const path = join(tmp, "Post.ts");
    const content = `// ${GENERATED_HEADER}\nexport const x = 1;`;
    const result = decideAndWrite(path, content);
    expect(result.status).toBe("new");
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  test("OVERWRITE: writes when existing file has @generated header", () => {
    const path = join(tmp, "Post.ts");
    writeFileSync(path, `// ${GENERATED_HEADER}\nexport const old = 1;`);
    const content = `// ${GENERATED_HEADER}\nexport const x = 2;`;
    const result = decideAndWrite(path, content);
    expect(result.status).toBe("overwrite");
    expect(readFileSync(path, "utf-8")).toBe(content);
  });

  test("REFUSED: leaves existing file alone if no @generated header", () => {
    const path = join(tmp, "Post.ts");
    const userContent = "// user wrote this\nexport const x = 1;";
    writeFileSync(path, userContent);
    const result = decideAndWrite(path, "ignored");
    expect(result.status).toBe("refused");
    expect(readFileSync(path, "utf-8")).toBe(userContent);
  });

  test("skip-existing strategy never writes existing files", () => {
    const path = join(tmp, "Post.ts");
    writeFileSync(path, `// ${GENERATED_HEADER}\nexport const old = 1;`);
    const result = decideAndWrite(path, "new content", "skip-existing");
    expect(result.status).toBe("skipped");
    expect(readFileSync(path, "utf-8")).toContain("old = 1");
  });
});
