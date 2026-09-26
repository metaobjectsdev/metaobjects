/**
 * A scratch adopter project for the "write your own generator" gates: `meta init`, a small
 * model that exercises what a generator most often gets wrong (an abstract base reached
 * through `extends`, an inherited array field, an enum, a `field.object` onto a value object,
 * a read-only projection), and a strict typecheck of whatever lives in codegen/generators/.
 *
 * Inside the workspace (test/fixtures/__tmp__, git-ignored) so `@metaobjectsdev/*` imports
 * in the owned generators resolve the way an installed project's would.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect } from "bun:test";
import { CLI_ROOT, meta } from "./built-cli.js";

export const WORKSPACE_TMP = resolve(CLI_ROOT, "test", "fixtures", "__tmp__");

export const SHOP_MODEL = {
  metadata: {
    package: "shop",
    children: [
      {
        "object.value": {
          name: "Address",
          children: [
            { "field.string": { name: "city", "@required": true } },
            { "field.string": { name: "zip", "@maxLength": 10 } },
          ],
        },
      },
      {
        "object.entity": {
          name: "BaseEntity",
          abstract: true,
          children: [
            { "field.long": { name: "id" } },
            { "field.timestamp": { name: "createdAt", "@required": true } },
            { "field.string": { name: "labels", isArray: true } },
            { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "Customer",
          extends: "BaseEntity",
          "@description": "A person who buys.",
          children: [
            { "source.rdb": { "@table": "customers" } },
            { "field.string": { name: "email", "@required": true, "@maxLength": 200 } },
            { "field.object": { name: "shipping", "@objectRef": "Address", "@storage": "jsonb" } },
          ],
        },
      },
      {
        "object.entity": {
          name: "OrderLine",
          extends: "BaseEntity",
          children: [
            { "source.rdb": { "@table": "order_lines" } },
            { "field.long": { name: "customerId", "@required": true } },
            { "field.enum": { name: "status", "@values": ["open", "paid"], "@required": true } },
            { "field.decimal": { name: "total", "@precision": 10, "@scale": 2 } },
            { "field.date": { name: "shipBy" } },
          ],
        },
      },
    ],
  },
};

/** `meta init` a fresh project with the shop model. Returns its root. */
export async function newShopProject(prefix: string): Promise<string> {
  mkdirSync(WORKSPACE_TMP, { recursive: true });
  const root = mkdtempSync(join(WORKSPACE_TMP, prefix));
  writeFileSync(join(root, "package.json"), `${JSON.stringify({ name: "shop", version: "1.0.0", type: "module" }, null, 2)}\n`);
  const init = await meta(root, "init", "--server", "typescript", "--no-skills", "--quiet");
  expect({ step: "init", ...init }).toMatchObject({ step: "init", exit: 0 });
  writeModel(root, SHOP_MODEL);
  return root;
}

export function writeModel(root: string, model: unknown): void {
  writeFileSync(join(root, "metaobjects", "meta.shop.json"), `${JSON.stringify(model, null, 2)}\n`);
}

/**
 * Typecheck the owned generators STRICTLY — `meta gen` loads them through jiti, which does
 * not typecheck, so this is the only thing that would catch a generator calling a method
 * that does not exist. Only codegen/ is checked: the config imports `@metaobjectsdev/cli`,
 * which a workspace scratch dir cannot resolve.
 */
export async function typecheckGenerators(root: string, files: string[]): Promise<{ exit: number; output: string }> {
  const tsc = join(CLI_ROOT, "node_modules", ".bin", "tsc");
  const proc = Bun.spawn(
    [tsc, "--noEmit", "--strict", "--noUnusedLocals", "--noUnusedParameters", "--target", "ES2022",
      "--module", "nodenext", "--moduleResolution", "nodenext", "--skipLibCheck", ...files],
    { cwd: root, stdout: "pipe", stderr: "pipe" },
  );
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exit, output: `${out}\n${err}` };
}
