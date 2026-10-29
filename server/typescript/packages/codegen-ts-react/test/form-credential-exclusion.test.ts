// #484: a credential (a field that declares `view.password`) is never rendered by a generated
// form, exactly like an `@formExclude` field. A generated form has no hashing seam, and the
// generated write route strips the value anyway.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaObject, type MetaRoot } from "@metaobjectsdev/metadata";
import { renderFormFile } from "../src/templates/form-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";

async function loadAccount(): Promise<{ root: MetaRoot; account: MetaObject }> {
  const { root, errors } = await new MetaDataLoader().load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "Account",
                children: [
                  { "source.rdb": { "@table": "accounts" } },
                  { "field.long": { name: "id" } },
                  { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
                  { "field.string": { name: "displayName", "@required": true } },
                  { "field.string": { name: "tokenHash", "@formExclude": true } },
                  { "field.string": { name: "pinHash", children: [{ "view.password": {} }] } },
                ],
              },
            },
          ],
        },
      }),
      { id: "account.json" },
    ),
  ]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  return { root, account: root.objects().find((o) => o.name === "Account")! as MetaObject };
}

describe("generated form — credential and @formExclude fields", () => {
  test("neither is rendered; an ordinary field is", async () => {
    const { root, account } = await loadAccount();
    const out = renderFormFile(
      account,
      makeRenderContext({
        dialect: "postgres",
        loadedRoot: root,
        outDir: "/x",
        dbImport: "../db",
        extStyle: "none",
        apiPrefix: "/api",
        pkMap: buildPkMap(root),
        relationMap: buildRelationMap(root),
      }),
    );
    expect(out).toContain("displayName");
    expect(out).not.toContain("tokenHash");
    expect(out).not.toContain("pinHash");
  });
});
