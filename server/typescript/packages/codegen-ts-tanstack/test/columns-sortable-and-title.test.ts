// #352 / #353 / #354 — the generated grid column and the generated server allowlist
// must agree, and a human-chosen header must be authorable in registered vocabulary.
//
// #352: ColumnSpec.sortable was declared and read but never assigned, so every emitted
//       meta omitted it. EntityGrid gates on `meta?.sortable !== false`, which an absent
//       value satisfies — so every header rendered clickable and a column outside the
//       server's SortAllowlist 400'd with `sort.unknown_field` when clicked.
// #353: fieldLabel() read `@label`, which NO provider registers (ERR_UNKNOWN_ATTR under
//       the strict registry `meta verify` uses), so the override branch was unreachable.
//       `title` is already a registered common attr on every node and already means
//       "a noun phrase" — the vocabulary existed; only the read was wrong.
// #354: the sortability rule lives in codegen-ts's filter-shared.ts and drives the
//       SERVER allowlist. It is imported here rather than reimplemented, so the two
//       sides cannot drift.
import { describe, test, expect } from "bun:test";
import { renderColumnsFile } from "../src/templates/columns-file.js";
import {
  makeRenderContext, buildPkMap, buildRelationMap, sortableFields,
} from "@metaobjectsdev/codegen-ts";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";

// Audit-log-shaped: every arm of isSortableField's three-branch rule is present, and
// one field carries a view-level @title so the header override has a real carrier.
const MODEL = JSON.stringify({
  "metadata.root": {
    children: [{
      "object.entity": {
        name: "AuditEntry",
        children: [
          { "source.rdb": { "@table": "audit_entry" } },
          { "field.long": { name: "id" } },
          { "identity.primary": { name: "pk", "@fields": ["id"], "@generation": "increment" } },
          // @sortable absent, @filterable true  -> sortable
          { "field.string": { name: "actor", "@filterable": true } },
          // @sortable true                      -> sortable
          { "field.string": { name: "action", "@sortable": true } },
          // @sortable false overrides @filterable -> NOT sortable
          { "field.string": { name: "payload", "@filterable": true, "@sortable": false } },
          // neither                             -> NOT sortable, and carries the header override
          { "field.string": { name: "note", children: [
            { "view.text": { name: "display", "@title": "Operator Note" } },
          ] } },
          { "layout.dataGrid": { name: "default",
            "@columns": ["actor", "action", "payload", "note"] } },
        ],
      },
    }],
  },
});

async function render(): Promise<{ out: string; root: MetaRoot }> {
  const { root, errors } = await new MetaDataLoader({ strict: true })
    .load([new InMemoryStringSource(MODEL, { id: "audit.json" })]);
  // The fixture must itself be legal under the strict registry — otherwise this test
  // would pin a header override an adopter's `meta verify` rejects, which is the exact
  // defect #353 reports.
  expect(errors.map((e) => (e as { code?: string }).code)).toEqual([]);
  const entity = root.objects().find((o) => o.name === "AuditEntry")!;
  const renderContext = makeRenderContext({
    dialect: "sqlite", loadedRoot: root, outDir: "/tmp",
    dbImport: "../db", extStyle: "none",
    pkMap: buildPkMap(root), relationMap: buildRelationMap(root),
  });
  return { out: renderColumnsFile(entity, renderContext), root };
}

/** The `meta: { ... }` object emitted for one column id. */
function metaFor(out: string, id: string): string {
  const parts = out.split(`id: ${JSON.stringify(id)}`);
  expect(parts.length).toBeGreaterThan(1);
  const m = (parts[1] ?? "").match(/meta:\s*\{([^}]*)\}/);
  expect(m).not.toBeNull();
  return m?.[1] ?? "";
}

describe("#352 — every generated column states its sortability", () => {
  test("each column's meta carries an explicit sortable flag", async () => {
    const { out } = await render();
    // Absent is the defect: EntityGrid reads `meta?.sortable !== false`, so an omitted
    // value renders the header clickable. Every column must say so one way or the other.
    for (const id of ["actor", "action", "payload", "note"]) {
      expect(metaFor(out, id)).toContain("sortable:");
    }
  });

  test("the flag follows isSortableField's three branches", async () => {
    const { out } = await render();
    expect(metaFor(out, "actor")).toContain("sortable: true");    // @filterable only
    expect(metaFor(out, "action")).toContain("sortable: true");   // @sortable: true
    expect(metaFor(out, "payload")).toContain("sortable: false"); // @sortable: false wins
    expect(metaFor(out, "note")).toContain("sortable: false");    // neither
  });

  test("the columns offered for sort are exactly the server's sortable field set", async () => {
    const { out, root } = await render();
    const entity = root.objects().find((o) => o.name === "AuditEntry")!;
    // sortableFields() is the same predicate that builds <Entity>SortAllowlist. If the
    // grid offers a header the allowlist omits, the click 400s `sort.unknown_field`.
    const serverSide = sortableFields(entity).map((f) => f.name).sort();
    const clientSide = ["actor", "action", "payload", "note"]
      .filter((id) => metaFor(out, id).includes("sortable: true")).sort();
    expect(clientSide).toEqual(serverSide);
  });
});

describe("#353 — a header override is authorable in registered vocabulary", () => {
  test("a view's @title becomes the column header", async () => {
    const { out } = await render();
    expect(out).toContain('header: "Operator Note"');
  });

  test("a field with no override still humanizes its name", async () => {
    const { out } = await render();
    expect(out).toContain('header: "Actor"');
  });
});
