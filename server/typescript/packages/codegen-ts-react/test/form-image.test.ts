// Form controls: renderFormFile dispatches a view.image field to <ImageUpload>
// wrapped in react-hook-form's <Controller> (a bound native <input> can't drive
// a file-upload control's value/onChange contract). The Controller/ImageUpload
// imports are gated — they must appear ONLY when the entity has an image field.
import { describe, test, expect } from "bun:test";
import {
  MetaDataLoader,
  InMemoryStringSource,
  type MetaObject,
  type MetaRoot,
} from "@metaobjectsdev/metadata";
import { renderFormFile } from "../src/templates/form-file.js";
import { makeRenderContext, buildPkMap, buildRelationMap } from "@metaobjectsdev/codegen-ts";

async function loadModel(): Promise<{ root: MetaRoot; doc: MetaObject; plain: MetaObject }> {
  const loader = new MetaDataLoader();
  const { root, errors } = await loader.load([
    new InMemoryStringSource(
      JSON.stringify({
        "metadata.root": {
          package: "demo",
          children: [
            {
              "object.entity": {
                name: "Doc",
                children: [
                  { "source.rdb": { "@table": "docs" } },
                  { "field.long": { name: "id" } },
                  { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
                  {
                    "field.string": {
                      name: "coverKey",
                      "@maxLength": 80,
                      children: [
                        {
                          "view.image": {
                            "@aspectRatio": 1.777,
                            "@maxEdge": 2000,
                            "@store": "photos",
                            "@accept": ["image/jpeg", "image/png"],
                            "@maxBytes": 10485760,
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
            {
              "object.entity": {
                name: "Plain",
                children: [
                  { "source.rdb": { "@table": "plains" } },
                  { "field.long": { name: "id" } },
                  { "identity.primary": { name: "id", "@fields": "id", "@generation": "increment" } },
                  { "field.string": { name: "name", "@required": true } },
                ],
              },
            },
          ],
        },
      }),
      { id: "doc.json" },
    ),
  ]);
  if (errors.length > 0) throw new Error(errors.map((e) => e.message).join("; "));
  const doc = root.objects().find((o) => o.name === "Doc")! as MetaObject;
  const plain = root.objects().find((o) => o.name === "Plain")! as MetaObject;
  return { root, doc, plain };
}

function ctxFor(root: MetaRoot) {
  return makeRenderContext({
    dialect: "postgres",
    loadedRoot: root,
    outDir: "/x",
    dbImport: "../db",
    extStyle: "none",
    apiPrefix: "/api",
    pkMap: buildPkMap(root),
    relationMap: buildRelationMap(root),
  });
}

describe("form controls — view.image dispatch", () => {
  test("a view.image field renders <ImageUpload> wrapped in <Controller>", async () => {
    const { root, doc } = await loadModel();
    const out = renderFormFile(doc, ctxFor(root));
    expect(out).toContain("<ImageUpload");
    expect(out).toContain("Controller");
    expect(out).not.toMatch(/form\.input\.coverKey/);
  });

  test("the gated imports are emitted for an image entity", async () => {
    const { root, doc } = await loadModel();
    const out = renderFormFile(doc, ctxFor(root));
    expect(out).toContain('import { Controller } from "react-hook-form"');
    // Specifically the ImageUpload specifier, not just any "@metaobjectsdev/react"
    // import — useEntityForm's import from the same package is unconditional.
    expect(out).toContain('import { ImageUpload } from "@metaobjectsdev/react"');
    expect(out).toMatch(/from "@metaobjectsdev\/react"/);
  });

  test("the <ImageUpload> meta object carries all five view.image attrs", async () => {
    const { root, doc } = await loadModel();
    const out = renderFormFile(doc, ctxFor(root));
    expect(out).toContain("aspectRatio: 1.777");
    expect(out).toContain("maxEdge: 2000");
    expect(out).toContain('store: "photos"');
    // Format-tolerant: the ts-poet `code` template reformats interpolated
    // content (e.g. adds a space after the array-literal comma).
    expect(out).toMatch(/accept:\s*\[\s*"image\/jpeg",\s*"image\/png"\s*\]/);
    expect(out).toContain("maxBytes: 10485760");
  });

  test("a non-image entity emits neither the ImageUpload import nor a Controller import (gated)", async () => {
    const { root, plain } = await loadModel();
    const out = renderFormFile(plain, ctxFor(root));
    // NOTE: useEntityForm is imported from "@metaobjectsdev/react" on every
    // generated form, image or not — so the gating assertion targets the
    // ImageUpload/Controller specifiers specifically, not the bare package.
    expect(out).not.toContain("ImageUpload");
    expect(out).not.toContain("Controller");
    expect(out).not.toContain('import { ImageUpload }');
  });
});
