// agent/ui.md describes what the generated forms and grids ARE, so a credential (a field that
// declares `view.password`) is described the way they treat it: excluded from the form, never a
// grid column, never the grid's initial sort, and neither filterable nor sortable.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource } from "@metaobjectsdev/metadata";
import { renderAgentUiPage } from "../src/generators/agent-ui-page.js";

async function page(): Promise<string> {
  const model = {
    "metadata.root": {
      children: [{
        "object.entity": {
          name: "Account",
          children: [
            { "source.rdb": { "@table": "account" } },
            { "field.long": { name: "id" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
            { "field.string": { name: "email", "@filterable": true } },
            {
              "field.string": {
                name: "pinHash", "@filterable": true, "@sortable": true,
                children: [{ "view.password": {} }],
              },
            },
            {
              "layout.dataGrid": {
                name: "default", "@columns": ["email", "pinHash"], "@defaultSortField": "pinHash",
              },
            },
          ],
        },
      }],
    },
  };
  const res = await new MetaDataLoader({ strict: true }).load([
    new InMemoryStringSource(JSON.stringify(model), { id: "meta.json", format: "json" }),
  ]);
  expect(res.errors).toEqual([]);
  return renderAgentUiPage(res.root);
}

describe("agent/ui.md describes a credential as the generated UI treats it", () => {
  test("its field row is marked excluded, and neither filterable nor sortable", async () => {
    const row = (await page()).split("\n").find((l) => l.startsWith("| `pinHash`"));
    expect(row).toBeDefined();
    const cells = row!.split("|").map((c) => c.trim());
    // | Field | Label | Control | HTML type | Rules | Excluded | Filter | Sort |
    expect(cells.slice(6, 9)).toEqual(["yes", "", ""]);
  });

  test("the grid section lists no credential column and no default sort on it", async () => {
    const out = await page();
    expect(out).toContain("- columns: `email`");
    expect(out).not.toContain("`email`, `pinHash`");
    expect(out).not.toContain("default sort");
  });
});
