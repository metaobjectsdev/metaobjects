// A timestamp's form control is `<input type="datetime-local">`, not `type="date"`.
//
// Every calendar/clock subtype defaults to the `date` VIEW, and the descriptor mapped that
// view straight to `htmlType: "date"`. The generated React form spreads
// `form.input.<field>` from that descriptor (`useEntityForm` copies `htmlType` onto the
// `<input type=…>`), so a `field.timestamp` rendered a date picker that cannot hold a time
// and submitted midnight, and a `field.time` rendered a date picker for a time of day.
// The nested value-object sub-form already mapped by subtype (`datetime-local` / `time`);
// the top-level descriptor now agrees with it.
//
// Executed, not text-matched: the emitted constants module is imported and read.

import { describe, test, expect, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { MetaDataLoader, InMemoryStringSource, type MetaObject } from "@metaobjectsdev/metadata";
import { renderEntityConstants } from "../src/templates/entity-constants.js";

const TEMP_DIRS: string[] = [];
afterAll(() => {
  for (const d of TEMP_DIRS) rmSync(d, { recursive: true, force: true });
});

const MODEL = {
  "metadata.root": {
    package: "tracker",
    children: [
      {
        "object.entity": {
          name: "Issue",
          children: [
            { "source.rdb": { "@table": "issues" } },
            { "field.long": { name: "id" } },
            { "field.date": { name: "dueDate" } },
            { "field.time": { name: "standupAt" } },
            { "field.timestamp": { name: "resolvedAt" } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
    ],
  },
};

async function loadIssue(): Promise<MetaObject> {
  const loaded = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(MODEL))]);
  expect(loaded.errors.map((e) => e.message)).toEqual([]);
  const issue = loaded.root.findObject("Issue");
  if (issue === undefined) throw new Error("Issue not loaded");
  return issue;
}

describe("form descriptor — the <input type> for date, time and timestamp fields", () => {
  test("date keeps `date`, time gets `time`, timestamp gets `datetime-local`", async () => {
    const issue = await loadIssue();
    const dir = mkdtempSync(join(import.meta.dir, "tmp-form-date-"));
    TEMP_DIRS.push(dir);
    const file = join(dir, "Issue.constants.ts");
    writeFileSync(file, renderEntityConstants(issue, "/api").toString());
    const mod = (await import(pathToFileURL(file).href)) as {
      Issue: Record<string, { view?: string; htmlType?: string }>;
    };
    expect(mod.Issue.dueDate?.htmlType).toBe("date");
    expect(mod.Issue.standupAt?.htmlType).toBe("time");
    expect(mod.Issue.resolvedAt?.htmlType).toBe("datetime-local");
    // The VIEW is unchanged — only the HTML input type it maps to depends on the subtype.
    expect(mod.Issue.resolvedAt?.view).toBe("date");
  });
});
