// FR-043 §3.4 / §3.5 — an adopter's own file in a shipped library's package, while that
// library is opted in.
//
// Two failures, opposite in shape and both SILENT before this guard:
//
//   the EJECTED COPY — `meta eject iam` hands you the metadata and tells you to drop
//     `iam` from `libraries`. Skip that and both trees load and merge: additions take,
//     DELETIONS do not, because the library still declares what you removed.
//   the NEW NODE — something of your own declared into `metaobjects::iam`, where the
//     next release of the library may ship a node of that name and merge into it.
//
// The `overlay: true` door stays open: that is the documented way to amend a shipped
// node while tracking upstream, and the loader's own `isMerge` is what tells the two
// apart — a distinction no comparison of the merged trees could make.
import { describe, test, expect } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadMemory } from "../src/memory.js";

/** An adopter file, loaded with `iam` opted in. Returns the thrown error, or undefined. */
async function loadWith(yaml: string, libraries: string[] = ["iam"]): Promise<Error | undefined> {
  const dir = mkdtempSync(join(tmpdir(), "lib-guard-"));
  try {
    mkdirSync(join(dir, "metaobjects"));
    writeFileSync(join(dir, "metaobjects", "mine.yaml"), yaml);
    await loadMemory(dir, { strict: true, libraries });
    return undefined;
  } catch (err) {
    return err as Error;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const COPY_OF_A_SHIPPED_NODE = `
metadata:
  package: metaobjects::iam
  children:
    - object.entity:
        name: User
        children:
          - field.string: { name: nickname }
`;

const OVERLAY_OF_A_SHIPPED_NODE = `
metadata:
  package: metaobjects::iam
  children:
    - object.entity:
        name: User
        overlay: true
        children:
          - field.string: { name: nickname }
`;

const A_NEW_NODE_IN_THE_LIBRARYS_PACKAGE = `
metadata:
  package: metaobjects::iam
  children:
    - object.entity:
        name: ApiKey
        children:
          - field.uuid: { name: id }
          - identity.primary: { name: pk, fields: [id] }
`;

const MY_OWN_PACKAGE = `
metadata:
  package: acme::app
  children:
    - object.entity:
        name: Account
        extends: metaobjects::iam::User
        children:
          - identity.primary: { name: pk, fields: [id] }
`;

describe("a shipped library's package, while it is opted in", () => {
  test("an ejected copy that is still opted in is refused, by name", async () => {
    const err = await loadWith(COPY_OF_A_SHIPPED_NODE);
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe("ERR_LIBRARY_PACKAGE_COLLISION");
    // The message has to say WHY silence would be worse: the merge is not a no-op, it
    // is asymmetric.
    expect(err!.message).toContain("metaobjects::iam::User");
    expect(err!.message).toContain("DELETIONS");
    // And the fix is the step `meta eject` already printed.
    expect((err as { suggestions?: string[] }).suggestions?.[0])
      .toContain("from 'libraries'");
  });

  test("a NEW node in the library's package is refused as not yours to declare", async () => {
    const err = await loadWith(A_NEW_NODE_IN_THE_LIBRARYS_PACKAGE);
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe("ERR_LIBRARY_PACKAGE_NOT_OWNED");
    expect(err!.message).toContain("metaobjects::iam::ApiKey");
  });

  test("an `overlay: true` amendment is the documented door and stays open", async () => {
    expect(await loadWith(OVERLAY_OF_A_SHIPPED_NODE)).toBeUndefined();
  });

  test("your own package extending a library node is untouched", async () => {
    expect(await loadWith(MY_OWN_PACKAGE)).toBeUndefined();
  });

  test("with the library NOT opted in, the guard says nothing", async () => {
    // The copy is then just your metadata — which is exactly the state `meta eject`
    // leaves you in once you remove the library from `libraries`. Refusing it there
    // would make the ejection door unusable.
    expect(await loadWith(COPY_OF_A_SHIPPED_NODE, [])).toBeUndefined();
  });

  test("the library's own layers do not trip it", async () => {
    // `iam/db` is nothing but `overlay: true` redeclarations of `iam`'s own nodes, from
    // library files. A guard keyed on "two files contributed" would fire on every one.
    const dir = mkdtempSync(join(tmpdir(), "lib-guard-"));
    try {
      mkdirSync(join(dir, "metaobjects"));
      writeFileSync(join(dir, "metaobjects", "mine.yaml"), MY_OWN_PACKAGE);
      const root = await loadMemory(dir, { strict: true, libraries: ["iam", "iam/db"] });
      expect(root.children().some((c) => c.name === "User")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
