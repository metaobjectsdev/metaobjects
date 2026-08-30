// FR-040 §4.4 — the published `latest` of react-table is a major ahead of what this
// package supports, so `npm i @tanstack/react-table` installs v9 and every subsequent
// install in that project fails ERESOLVE. The range is CORRECT; the requirement must be
// discoverable so an adopter does not hit it blind.
import { describe, test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const readme = readFileSync(join(root, "README.md"), "utf8");

describe("react-table peer requirement", () => {
  test("the peer range is bounded to v8", () => {
    expect(pkg.peerDependencies["@tanstack/react-table"]).toMatch(/\^8\./);
  });

  test("the README states the v8 pin and why a bare install breaks", () => {
    expect(readme).toMatch(/@tanstack\/react-table@\^8/);
    expect(readme).toMatch(/ERESOLVE/);
  });
});
