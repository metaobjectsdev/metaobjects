import { expect, test } from "bun:test";
import { badge, legendHtml, esc, LEGEND } from "../src/badges";

test("badges escape and carry semantic classes; legend covers the 6 roles", () => {
  expect(esc(`<a>"&`)).toBe("&lt;a&gt;&quot;&amp;");
  expect(badge({ text: "required", cls: "badge-soft badge-error" })).toContain("badge-error");
  const fk = badge({ text: "→ User", cls: "badge-soft badge-info", href: "x.html", title: "fk" });
  expect(fk).toContain(`href="x.html"`);
  expect(fk).toContain("badge-info");
  expect(LEGEND.map((l) => l.label)).toEqual(
    ["reference (fk)", "contains (nested)", "indexed / pk", "required", "deprecated", "enum", "optional"],
  );
  expect(legendHtml()).toContain("badge-info");
});
