// `meta generator new` wires the new generator into metaobjects.config.ts by TEXT edit, and
// refuses rather than guesses when the config's shape is not one it can edit safely.
import { describe, expect, test } from "bun:test";
import { wireGeneratorIntoConfig } from "../../src/commands/generator.js";

const IMPORT = `import { fieldListGenerator } from "./codegen/generators/field-list.js";`;
const ENTRY = "fieldListGenerator()";

describe("wireGeneratorIntoConfig", () => {
  test("the init scaffold's empty selection gains the import and the entry", () => {
    const src = `import { defineConfig } from "@metaobjectsdev/cli";

export default defineConfig({
  outDir: "src/generated",
  generators: [],
});
`;
    const r = wireGeneratorIntoConfig(src, IMPORT, ENTRY);
    expect(r.status).toBe("wired");
    expect(r.source).toContain(`import { defineConfig } from "@metaobjectsdev/cli";\n${IMPORT}\n`);
    expect(r.source).toContain("generators: [fieldListGenerator()],");
  });

  test("a one-line selection is appended to", () => {
    const src = `import { defineConfig } from "@metaobjectsdev/cli";
import { entityFile } from "./codegen/generators/entity.js";
export default defineConfig({ generators: [entityFile({ filter: (e) => [1].length > 0 })] });
`;
    const r = wireGeneratorIntoConfig(src, IMPORT, ENTRY);
    expect(r.status).toBe("wired");
    expect(r.source).toContain("generators: [entityFile({ filter: (e) => [1].length > 0 }), fieldListGenerator()] });");
    // The import goes after the LAST import, not the first.
    expect(r.source.indexOf(IMPORT)).toBeGreaterThan(r.source.indexOf("entity.js"));
  });

  test("a multi-line selection gets a new line at the elements' indent", () => {
    const src = `import { defineConfig } from "@metaobjectsdev/cli";
export default defineConfig({
  generators: [
    entityFile(),
    barrel(), // keeps its comment
  ],
});
`;
    const r = wireGeneratorIntoConfig(src, IMPORT, ENTRY);
    expect(r.status).toBe("wired");
    expect(r.source).toContain("    barrel(), // keeps its comment\n    fieldListGenerator(),\n  ],");
  });

  test("a string holding a bracket does not end the array early", () => {
    const src = `import { defineConfig } from "@metaobjectsdev/cli";
export default defineConfig({ generators: [templateGenerator({ outputPattern: "a]b" })] });
`;
    const r = wireGeneratorIntoConfig(src, IMPORT, ENTRY);
    expect(r.source).toContain(`generators: [templateGenerator({ outputPattern: "a]b" }), fieldListGenerator()] });`);
  });

  test("already wired is a no-op", () => {
    const src = `${IMPORT}\nexport default defineConfig({ generators: [fieldListGenerator()] });\n`;
    const r = wireGeneratorIntoConfig(src, IMPORT, ENTRY);
    expect(r.status).toBe("already-wired");
    expect(r.source).toBe(src);
  });

  test("a selection built elsewhere is left alone — the caller prints what to add", () => {
    const src = `import { defineConfig } from "@metaobjectsdev/cli";
const mine = [entityFile()];
export default defineConfig({ generators: mine });
`;
    const r = wireGeneratorIntoConfig(src, IMPORT, ENTRY);
    expect(r.status).toBe("manual");
    expect(r.source).toBe(src);
  });

  test("two generators arrays (e.g. per-target configs) are ambiguous, so it does not guess", () => {
    const src = `export default defineConfig({ generators: [a()], other: { generators: [b()] } });\n`;
    expect(wireGeneratorIntoConfig(src, IMPORT, ENTRY).status).toBe("manual");
  });
});
