# Docs Site — Phase 2 (Shared Relationship IR) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Re-source the docs-site's *relationship* diagram edges from the `@metaobjectsdev/metadata` relationship primitives so the site covers M:N-through-junction, directed/symmetric self-joins, belongs-to cardinality, and `@onDelete`, and de-duplicate the relationship-vs-bare-FK double edge — with the presentation layer and gates preserved.

**Architecture:** Keep `LinkGraph` as the graph shell (nodes, from/to indices, query API). Replace only its relationship-edge derivation: read `MetaRelationship` getters (`cardinality`/`objectRef`/`through`/`symmetric`/`onDelete`) and derive M:N junction FK fields via `deriveM2MFields` (the SSOT). Suppress the bare `fk` edge when a belongs-to relationship covers the same reference. Structural edges (`fk`/`field`/`origin`/`extends`/`payload`) are unchanged — they already resolve the `extends` chain via `childrenOfType` → `children()`. Render the new M:N edge with mermaid's `}o--o{` (ER) / dashed link (flowchart).

**Tech Stack:** bun, TypeScript (monorepo `tsconfig.base.json`), `@metaobjectsdev/metadata` (relationship primitives), `@metaobjectsdev/render`, mustache, mermaid.

**Spec:** `docs/superpowers/specs/2026-07-04-docs-site-phase2-design.md`

## Global Constraints

- **Public repo hygiene:** no private/downstream project names, no `/home/…` absolute paths, in code, tests, fixtures, or commit messages. A commit guard enforces a private-name denylist on every commit; also `grep -rniE "/home/"` the touched files (and eyeball for stray project names) before committing.
- **No new package dependency:** all primitives (`deriveM2MFields`, `MetaRelationship`, `stripPackage`, `MetaObject`) are barrel-exported from `@metaobjectsdev/metadata`, which docs-site already depends on. Do **not** add `@metaobjectsdev/codegen-ts`.
- **Determinism:** every emitted edge/attr list sorts; no Map/Set insertion-order leakage. The golden must be byte-identical across two regenerations.
- **Link-check:** `generateSite` throws on any dangling link — regeneration failing IS a test failure.
- **Escaping invariant:** new edge-label text (relationship name, junction name, `onDelete` value) still passes through the existing `safe()` (mermaid) / `edgeLabel()` (flowchart) / `esc()` (HTML) — never inject raw text into a slot.
- **`erDiagramRich` connector rule:** M:N (`cardinality === "many"`) → `}o--o{`; everything else → the existing `||--o{`. This keeps non-M:N output byte-identical.

### Regenerating the golden (used by several tasks)

From `server/typescript/packages/docs-site/`:

```bash
bun -e 'import {generateSite} from "./src/site.ts"; import {rmSync} from "node:fs"; rmSync("test/fixture/golden",{recursive:true,force:true}); await generateSite({sourceDirs:["test/fixture/input/acme"],outDir:"test/fixture/golden",title:"Fixture",stamp:"2026-01-01",commit:"abc1234"}); console.log("golden regenerated");'
```

This mirrors `test/golden.test.ts` exactly (same `title`/`stamp`/`commit`). After regenerating, `bun test test/golden.test.ts` must pass, and running it **twice** confirms determinism. If the regen command throws, a link is dangling — fix the derivation, do not hand-edit the golden.

---

## File Structure

- `src/link-graph.ts` — MODIFY: extend `Ref`; rewrite the relationship-edge derivation; add dedupe. (~30 lines changed in the constructor + the `Ref` interface.)
- `src/mermaid.ts` — MODIFY: `ErEdge` gains `cardinality?`; `erDiagramRich` connector by cardinality; `flowchartDomain` edge input gains `style?`, dashed link; genericize `CURATED` keys.
- `src/builders/object-data.ts` — MODIFY: thread `cardinality`/`through`/`onDelete` into the neighborhood `ErEdge`/flowchart edges + labels.
- `src/builders/index-data.ts` — MODIFY: thread `cardinality`/`style` into the hero/core edges.
- `test/fixture/input/acme/shop/meta.shop.yaml` — MODIFY: add M:N + self-join entities/relationships + `@onDelete`.
- `test/fixture/golden/**` — REGENERATE.
- `test/link-graph.test.ts`, `test/mermaid.test.ts` — MODIFY: new assertions.

---

## Task 1: Extend the acme fixture (M:N, self-joins, onDelete)

**Files:**
- Modify: `test/fixture/input/acme/shop/meta.shop.yaml`
- Modify: `test/fixture/golden/**` (regenerate)
- Test: `test/link-graph.test.ts` (add a load/presence assertion)

**Interfaces:**
- Produces: fixture entities `Product`, `OrderProduct`, `CustomerReferral`, `CustomerFriend`; relationships `Order.customer` (now with `@onDelete: cascade`), `Order.products` (M:N via `OrderProduct`), `Customer.referrals` (directed self-join via `CustomerReferral`, `@sourceRefField: referrerId`), `Customer.friends` (symmetric self-join via `CustomerFriend`).

- [ ] **Step 1: Add the M:N + self-join entities.** In `meta.shop.yaml`, after the `OrphanLog` entity (before the `LineItemView` projection), add:

```yaml
    - object.entity:
        name: Product
        extends: acme::common::BaseEntity
        children:
          - field.string: { name: sku, required: true, maxLength: 40 }
          - source.rdb: { table: products }
    - object.entity:
        name: OrderProduct
        extends: acme::common::BaseEntity
        children:
          - field.string: { name: orderId, maxLength: 36 }
          - field.string: { name: productId, maxLength: 36 }
          - identity.reference: { name: fkOrder, fields: orderId, references: acme::shop::Order }
          - identity.reference: { name: fkProduct, fields: productId, references: acme::shop::Product }
          - source.rdb: { table: order_products }
    - object.entity:
        name: CustomerReferral
        extends: acme::common::BaseEntity
        children:
          - field.string: { name: referrerId, maxLength: 36 }
          - field.string: { name: referredId, maxLength: 36 }
          - identity.reference: { name: fkReferrer, fields: referrerId, references: acme::shop::Customer }
          - identity.reference: { name: fkReferred, fields: referredId, references: acme::shop::Customer }
          - source.rdb: { table: customer_referrals }
    - object.entity:
        name: CustomerFriend
        extends: acme::common::BaseEntity
        children:
          - field.string: { name: friendAId, maxLength: 36 }
          - field.string: { name: friendBId, maxLength: 36 }
          - identity.reference: { name: fkFriendA, fields: friendAId, references: acme::shop::Customer }
          - identity.reference: { name: fkFriendB, fields: friendBId, references: acme::shop::Customer }
          - source.rdb: { table: customer_friends }
```

- [ ] **Step 2: Add `@onDelete` to the existing belongs-to + the new M:N relationships.** In `meta.shop.yaml`, replace the `Order` `customer` relationship line:

```yaml
          - relationship.association: { name: customer, "@objectRef": "acme::shop::Customer", cardinality: one }
```
with (adds `@onDelete` and the M:N `products` relationship right after it):
```yaml
          - relationship.association: { name: customer, "@objectRef": "acme::shop::Customer", cardinality: one, "@onDelete": cascade }
          - relationship.association: { name: products, "@objectRef": "acme::shop::Product", cardinality: many, "@through": "acme::shop::OrderProduct" }
```

Then add the two self-join relationships to `Customer` — replace:
```yaml
        name: Customer
        extends: acme::common::BaseEntity
        children:
          - field.string: { name: email, required: true, maxLength: 120 }
          - source.rdb: { table: customers }
```
with:
```yaml
        name: Customer
        extends: acme::common::BaseEntity
        children:
          - field.string: { name: email, required: true, maxLength: 120 }
          - relationship.association: { name: referrals, "@objectRef": "acme::shop::Customer", cardinality: many, "@through": "acme::shop::CustomerReferral", "@sourceRefField": referrerId }
          - relationship.association: { name: friends, "@objectRef": "acme::shop::Customer", cardinality: many, "@through": "acme::shop::CustomerFriend", "@symmetric": true }
          - source.rdb: { table: customers }
```

- [ ] **Step 3: Write the load/presence test.** In `test/link-graph.test.ts`, add:

```ts
test("phase-2 fixture loads the M:N + self-join entities", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  for (const fqn of ["acme::shop::Product", "acme::shop::OrderProduct", "acme::shop::CustomerReferral", "acme::shop::CustomerFriend"]) {
    expect(g.byFqn(fqn), fqn).toBeDefined();
  }
});
```

- [ ] **Step 4: Run the load test.** Run: `cd server/typescript/packages/docs-site && bun test test/link-graph.test.ts -t "phase-2 fixture loads"`. Expected: PASS.

- [ ] **Step 5: Regenerate the golden + confirm determinism.** From `server/typescript/packages/docs-site/`, run the regen command (see "Regenerating the golden"). Then:

```bash
bun test test/golden.test.ts
bun test test/golden.test.ts   # run twice — both must pass (determinism)
```
Expected: PASS both times. (The golden now has new pages `acme/shop/Product.html`, `OrderProduct.html`, `CustomerReferral.html`, `CustomerFriend.html`, and the graph gains shallow relationship edges — enriched in later tasks.)

- [ ] **Step 6: Hygiene + commit.**

```bash
grep -rniE "/home/" test/fixture/input/acme/shop/meta.shop.yaml && echo LEAK || echo clean
git add test/
git commit -m "test(docs-site): extend acme fixture with M:N + directed/symmetric self-joins + onDelete"
```

---

## Task 2: Extend `Ref`, enrich belongs-to, dedupe the relationship-vs-FK edge

**Files:**
- Modify: `src/link-graph.ts` (the `Ref` interface + the `kind === "object"` derivation block)
- Modify: `test/link-graph.test.ts`
- Modify: `test/fixture/golden/**` (regenerate)

**Interfaces:**
- Produces: `Ref` extended with `cardinality?: "one" | "many"; through?: string; sourceJoinField?: string; targetJoinField?: string; symmetric?: boolean; onDelete?: string; subtype?: string;`. Belongs-to relationship edges carry normalized `cardinality`, `onDelete`, `subtype`; the bare `fk` edge for the same reference is suppressed.
- Consumes: fixture from Task 1.

- [ ] **Step 1: Extend the `Ref` interface.** In `src/link-graph.ts`, replace:

```ts
export interface Ref { from: string; to: string; via: string; kind: "field" | "fk" | "extends" | "payload" | "relationship" | "origin"; cardinality?: string; }
```
with:
```ts
export interface Ref {
  from: string; to: string; via: string;
  kind: "field" | "fk" | "extends" | "payload" | "relationship" | "origin";
  cardinality?: "one" | "many" | undefined;
  through?: string | undefined;         // junction FQN (M:N)
  sourceJoinField?: string | undefined; // junction source FK (M:N)
  targetJoinField?: string | undefined; // junction target FK (M:N)
  symmetric?: boolean | undefined;      // undirected self-join (M:N)
  onDelete?: string | undefined;        // referential action
  subtype?: string | undefined;         // association / aggregation / composition
}
```

- [ ] **Step 2: Import the metadata primitives.** In `src/link-graph.ts`, replace the top import:

```ts
import type { MetaData } from "@metaobjectsdev/metadata";
```
with:
```ts
import type { MetaData, MetaObject, MetaRelationship } from "@metaobjectsdev/metadata";
import { deriveM2MFields, stripPackage } from "@metaobjectsdev/metadata";
```
(`deriveM2MFields` is used in Task 3; importing it now keeps the import block stable.)

- [ ] **Step 3: Write the failing tests.** In `test/link-graph.test.ts`, add:

```ts
test("belongs-to relationship edge carries cardinality/onDelete/subtype and supersedes the bare FK", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  const toCustomer = g.refsFrom("acme::shop::Order").filter((r) => r.to === "acme::shop::Customer");
  // the FK edge is de-duplicated away; only the enriched relationship edge remains
  expect(toCustomer.map((r) => r.kind)).toEqual(["relationship"]);
  const rel = toCustomer[0]!;
  expect(rel.cardinality).toBe("one");
  expect(rel.onDelete).toBe("cascade");
  expect(rel.subtype).toBe("association");
  expect(rel.via).toBe("customer");
});
```
Also UPDATE the existing assertion in the "builds nodes, refs, backlinks, degree, hrefs" test — the FK edge to Customer is now superseded, and Customer gains the two self-join relationships from Customer itself is not a backlink target of those (they point Customer→Customer). Replace:
```ts
  // FK ref Order -> Customer via customerId
  expect(g.refsFrom("acme::shop::Order").some((r) => r.to === "acme::shop::Customer" && r.kind === "fk")).toBe(true);
```
```ts
  // backlink + degree: 3 refs (Order fk + Order relationship + LineItemView origin-passthrough)
  expect(g.refsTo("acme::shop::Customer").length).toBe(3);
  expect(g.degree("acme::shop::Customer")).toBe(3);
```
with:
```ts
  // Order -> Customer is now the enriched relationship edge (the bare FK is de-duped away)
  expect(g.refsFrom("acme::shop::Order").some((r) => r.to === "acme::shop::Customer" && r.kind === "relationship")).toBe(true);
  expect(g.refsFrom("acme::shop::Order").some((r) => r.to === "acme::shop::Customer" && r.kind === "fk")).toBe(false);
  // backlinks to Customer: Order.customer (relationship) + LineItemView origin-passthrough
  //   + the self-join junction FKs (CustomerReferral x2, CustomerFriend x2) + the self relationships (referrals, friends)
  expect(g.refsTo("acme::shop::Customer").some((r) => r.from === "acme::shop::Order" && r.kind === "relationship")).toBe(true);
  expect(g.refsTo("acme::shop::Customer").some((r) => r.from === "acme::shop::Order" && r.kind === "fk")).toBe(false);
```

- [ ] **Step 4: Run to verify failure.** Run: `bun test test/link-graph.test.ts`. Expected: FAIL (edges still `fk`; `cardinality`/`onDelete`/`subtype` undefined).

- [ ] **Step 5: Rewrite the relationship + FK derivation.** In `src/link-graph.ts`, inside `if (dn.kind === "object") { … }`, the current order is: field(objectRef) → identity(fk) → relationship → field(origin) → extends. Replace the **identity(fk)** block and the **relationship** block with a single relationship-first + dedupe sequence. Specifically, replace:

```ts
        for (const id of dn.node.childrenOfType("identity")) {
          if (id.subType !== "reference") continue;
          const ref = id.attr("references");
          if (typeof ref === "string") {
            const to = resolveRef(ref, dn.pkg);
            if (to) {
              const fieldsValue = id.attr("fields") ?? id.name;
              const via = Array.isArray(fieldsValue) ? fieldsValue.join(", ") : String(fieldsValue);
              addRef({ from: fqn, to, via, kind: "fk" });
            }
          }
        }
        for (const rel of dn.node.childrenOfType("relationship")) {
          const ref = rel.attr("objectRef");
          if (typeof ref === "string") {
            const to = resolveRef(ref, dn.pkg);
            if (to) addRef({ from: fqn, to, via: rel.name, kind: "relationship", cardinality: String(rel.attr("cardinality") ?? "") });
          }
        }
```
with:
```ts
        const obj = dn.node as unknown as MetaObject;
        // Relationship edges FIRST, so we can suppress the bare FK edge a belongs-to
        // relationship supersedes. Dedupe is keyed by `${targetFqn}::${fkField}`
        // (a string, robust to node-instance identity) — the FK loop skips any
        // reference whose (target, first-field) a belongs-to relationship covered.
        const coveredFk = new Set<string>();
        for (const rel of obj.relationships()) {
          const objectRef = rel.objectRef;
          if (typeof objectRef !== "string") continue;
          const to = resolveRef(objectRef, dn.pkg);
          if (!to) continue;
          const cardinality = rel.cardinality === "many" ? "many" : rel.cardinality === "one" ? "one" : undefined;
          const onDelete = rel.onDelete;
          const subtype = rel.subType;
          if (cardinality === "many" && rel.through !== undefined) {
            addM2mEdge(fqn, to, rel, obj, dn.pkg, onDelete, subtype);   // Task 3 helper
            continue;
          }
          // belongs-to (1:N, one) — find the matching identity.reference to dedupe (mirrors
          // relation-resolver: first reference whose target matches, package-stripped).
          const target = stripPackage(objectRef);
          const match = obj.referenceIdentities().find((r) => stripPackage(r.targetEntity ?? "") === target);
          const fkField = match?.fields?.[0];
          if (fkField) coveredFk.add(`${to}::${fkField}`);
          addRef({ from: fqn, to, via: rel.name, kind: "relationship", cardinality, onDelete, subtype });
        }
        for (const id of dn.node.childrenOfType("identity")) {
          if (id.subType !== "reference") continue;
          const ref = id.attr("references");
          if (typeof ref === "string") {
            const to = resolveRef(ref, dn.pkg);
            if (to) {
              const fieldsValue = id.attr("fields") ?? id.name;
              const firstField = Array.isArray(fieldsValue) ? String(fieldsValue[0] ?? "") : String(fieldsValue);
              if (coveredFk.has(`${to}::${firstField}`)) continue;   // superseded by a relationship edge
              const via = Array.isArray(fieldsValue) ? fieldsValue.join(", ") : String(fieldsValue);
              addRef({ from: fqn, to, via, kind: "fk" });
            }
          }
        }
```

Note: dedupe is keyed by the `${targetFqn}::${fkField}` string, so it does not depend on `referenceIdentities()` and `childrenOfType("identity")` returning the same node instances. `addM2mEdge` is defined in Task 3; add a temporary stub NOW so this compiles:

```ts
    // TEMP stub — replaced in Task 3. For now, emit a plain (un-derived) M:N edge.
    const addM2mEdge = (from: string, to: string, rel: MetaRelationship, _obj: MetaObject, _pkg: string, onDelete: string | undefined, subtype: string | undefined): void => {
      addRef({ from, to, via: rel.name, kind: "relationship", cardinality: "many", through: rel.through, symmetric: rel.symmetric, onDelete, subtype });
    };
```
Place this `addM2mEdge` declaration next to `addRef`/`resolveRef` (before the `for (const dn of this._nodes.values())` loop) so it is in scope.

- [ ] **Step 6: Run to verify pass.** Run: `bun test test/link-graph.test.ts`. Expected: PASS (all tests, including the updated backlink assertions).

- [ ] **Step 7: Regenerate the golden + determinism.** Run the regen command, then `bun test test/golden.test.ts` twice. Expected: PASS both. (Golden diff: Order's neighborhood edge to Customer flips from the `customerId` FK label to the `customer` relationship; the relations table gains `onDelete`.)

- [ ] **Step 8: Typecheck + commit.**

```bash
bun run typecheck
grep -rniE "/home/" src/link-graph.ts && echo LEAK || echo clean
git add src/link-graph.ts test/link-graph.test.ts test/fixture/golden
git commit -m "feat(docs-site): enrich belongs-to relationship edges (cardinality/onDelete/subtype) + dedupe the bare FK"
```
Expected: typecheck clean.

---

## Task 3: M:N-through-junction edges via `deriveM2MFields` (hetero + directed + symmetric)

**Files:**
- Modify: `src/link-graph.ts` (replace the `addM2mEdge` stub with the real derivation)
- Modify: `test/link-graph.test.ts`
- Modify: `test/fixture/golden/**` (regenerate)

**Interfaces:**
- Consumes: `deriveM2MFields(rel, source, root): { sourceField, targetField }`, `MetaRelationship` (`through`/`symmetric`), the `Ref` M:N fields from Task 2.
- Produces: M:N relationship edges carrying `through` (junction FQN), `sourceJoinField`, `targetJoinField`, `symmetric`. A derivation failure skips the edge (never throws out of generation).

- [ ] **Step 1: Write the failing tests.** In `test/link-graph.test.ts`, add:

```ts
test("M:N through-junction edge carries the derived join fields (hetero)", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  const e = g.refsFrom("acme::shop::Order").find((r) => r.to === "acme::shop::Product");
  expect(e).toBeDefined();
  expect(e!.kind).toBe("relationship");
  expect(e!.cardinality).toBe("many");
  expect(e!.through).toBe("acme::shop::OrderProduct");
  expect(e!.sourceJoinField).toBe("orderId");
  expect(e!.targetJoinField).toBe("productId");
  // the junction is still its own node with its two FK edges (neither covered by a relationship)
  expect(g.refsFrom("acme::shop::OrderProduct").filter((r) => r.kind === "fk").map((r) => r.to).sort())
    .toEqual(["acme::shop::Order", "acme::shop::Product"]);
});

test("directed self-join (@sourceRefField) resolves source/target join fields", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  const e = g.refsFrom("acme::shop::Customer").find((r) => r.to === "acme::shop::Customer" && r.via === "referrals");
  expect(e).toBeDefined();
  expect(e!.through).toBe("acme::shop::CustomerReferral");
  expect(e!.sourceJoinField).toBe("referrerId");
  expect(e!.targetJoinField).toBe("referredId");
  expect(e!.symmetric).toBeFalsy();
});

test("symmetric self-join (@symmetric) is flagged symmetric", async () => {
  const model = await loadModel([join(FIX, "acme")]);
  const g = new LinkGraph(model);
  const e = g.refsFrom("acme::shop::Customer").find((r) => r.to === "acme::shop::Customer" && r.via === "friends");
  expect(e).toBeDefined();
  expect(e!.through).toBe("acme::shop::CustomerFriend");
  expect(e!.symmetric).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test test/link-graph.test.ts -t "join fields"`. Expected: FAIL (`sourceJoinField`/`targetJoinField` undefined — the stub does not derive them).

- [ ] **Step 3: Replace the `addM2mEdge` stub with the real derivation.** In `src/link-graph.ts`, replace the temporary `addM2mEdge` stub from Task 2 with:

```ts
    // M:N through-junction edge. Derives the junction FK fields via the metadata
    // SSOT (deriveM2MFields) — hetero, directed (@sourceRefField), or symmetric
    // (@symmetric). On a derivation failure (ambiguous self-join) the edge is
    // SKIPPED — generation never fails.
    const addM2mEdge = (from: string, to: string, rel: MetaRelationship, obj: MetaObject, ctxPkg: string, onDelete: string | undefined, subtype: string | undefined): void => {
      const through = rel.through ? (resolveRef(rel.through, ctxPkg) ?? rel.through) : undefined;
      let sourceJoinField: string | undefined, targetJoinField: string | undefined;
      try {
        const f = deriveM2MFields(rel, obj, model.root);
        sourceJoinField = f.sourceField;
        targetJoinField = f.targetField;
      } catch {
        return;  // ambiguous junction — skip the logical edge (the two FK edges still show)
      }
      addRef({ from, to, via: rel.name, kind: "relationship", cardinality: "many", through, sourceJoinField, targetJoinField, symmetric: rel.symmetric, onDelete, subtype });
    };
```

- [ ] **Step 4: Run to verify pass.** Run: `bun test test/link-graph.test.ts`. Expected: PASS (all).

- [ ] **Step 5: Regenerate the golden + determinism.** Run the regen command, then `bun test test/golden.test.ts` twice. Expected: PASS both. (Golden diff: Order and Customer neighborhoods gain the M:N logical edges; junctions remain as nodes.)

- [ ] **Step 6: Typecheck + commit.**

```bash
bun run typecheck
git add src/link-graph.ts test/link-graph.test.ts test/fixture/golden
git commit -m "feat(docs-site): derive M:N through-junction edges (hetero/directed/symmetric) via deriveM2MFields"
```

---

## Task 4: Render cardinality — `}o--o{` (ER) + dashed M:N (flowchart)

**Files:**
- Modify: `src/mermaid.ts` (`ErEdge`, `erDiagramRich`, `flowchartDomain`)
- Modify: `src/builders/object-data.ts` (thread `cardinality`/`through`/`onDelete` into edges + labels)
- Modify: `src/builders/index-data.ts` (thread `cardinality`/`style` into hero edges)
- Modify: `test/mermaid.test.ts`
- Modify: `test/fixture/golden/**` (regenerate)

**Interfaces:**
- Produces: `ErEdge` gains `cardinality?: "one" | "many"`; `flowchartDomain` edge input gains `style?: "dashed"`. `erDiagramRich` emits `}o--o{` for `cardinality === "many"`, else `||--o{`; `flowchartDomain` emits `-.->` for `style === "dashed"`, else `-->`.

- [ ] **Step 1: Write the failing mermaid tests.** In `test/mermaid.test.ts`, add:

```ts
test("erDiagramRich uses }o--o{ for M:N edges and ||--o{ otherwise", () => {
  const { erDiagramRich } = require("../src/mermaid");
  const nodes = [
    { name: "Order", pkg: "acme::shop", role: "focal", attrs: [], more: 0 },
    { name: "Product", pkg: "acme::shop", role: "normal", attrs: [], more: 0 },
    { name: "Customer", pkg: "acme::shop", role: "normal", attrs: [], more: 0 },
  ];
  const out = erDiagramRich(nodes, [
    { parent: "Order", child: "Product", label: "products", cardinality: "many" },
    { parent: "Customer", child: "Order", label: "customer", cardinality: "one" },
  ]);
  expect(out).toContain("Order }o--o{ Product");
  expect(out).toContain("Customer ||--o{ Order");
});

test("flowchartDomain draws a dashed link for style:dashed", () => {
  const { flowchartDomain } = require("../src/mermaid");
  const r = flowchartDomain(
    [{ name: "Order", pkg: "acme::shop" }, { name: "Product", pkg: "acme::shop" }],
    [{ from: "Order", to: "Product", label: "M:N via OrderProduct", style: "dashed" }],
  );
  expect(r.mermaid).toContain("-.->|M:N via OrderProduct|");
});
```

- [ ] **Step 2: Run to verify failure.** Run: `bun test test/mermaid.test.ts -t "M:N"`. Expected: FAIL.

- [ ] **Step 3: Extend `ErEdge` + the emitters.** In `src/mermaid.ts`:

Replace the `ErEdge` interface (line 1):
```ts
export interface ErEdge { parent: string; child: string; label: string; }
```
with:
```ts
export interface ErEdge { parent: string; child: string; label: string; cardinality?: "one" | "many" | undefined; }
```

Replace the `erDiagramRich` edge line (currently `for (const e of [...edges].sort(edgeSort)) lines.push(\`  ${nodeId(e.parent)} ||--o{ ${nodeId(e.child)} : "${safe(e.label)}"\`);`) with:
```ts
  for (const e of [...edges].sort(edgeSort)) {
    const conn = e.cardinality === "many" ? "}o--o{" : "||--o{";
    lines.push(`  ${nodeId(e.parent)} ${conn} ${nodeId(e.child)} : "${safe(e.label)}"`);
  }
```

In `flowchartDomain`, change the edge input type and the edge emission. Replace the signature's edge param type `edges: { from: string; to: string; label?: string }[]` with `edges: { from: string; to: string; label?: string; style?: "dashed" | undefined }[]`, and replace the emission block:
```ts
  for (const e of [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))) {
    const lbl = e.label ? edgeLabel(e.label) : "";
    lines.push(lbl ? `  ${nodeId(e.from)} -->|${lbl}| ${nodeId(e.to)}` : `  ${nodeId(e.from)} --> ${nodeId(e.to)}`);
  }
```
with:
```ts
  for (const e of [...edges].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to))) {
    const lbl = e.label ? edgeLabel(e.label) : "";
    const arrow = e.style === "dashed" ? "-.->" : "-->";
    lines.push(lbl ? `  ${nodeId(e.from)} ${arrow}|${lbl}| ${nodeId(e.to)}` : `  ${nodeId(e.from)} ${arrow} ${nodeId(e.to)}`);
  }
```

- [ ] **Step 4: Run to verify pass.** Run: `bun test test/mermaid.test.ts`. Expected: PASS.

- [ ] **Step 5: Thread the new edge data through `object-data.ts`.** In `src/builders/object-data.ts`, the neighborhood builds `nbCandidates` with `edge: { parent, child, label }`. Enrich the label + cardinality. Replace the two `nbCandidates.set(...)` lines (the `refsFrom` and `refsTo` loops) so the edge object becomes:

```ts
  for (const r of g.refsFrom(fqn)) { const t = g.byFqn(r.to); if (t && !nbCandidates.has(r.to)) nbCandidates.set(r.to, { node: t, edge: { parent: t.name, child: dn.name, label: edgeLabelFor(r), cardinality: r.cardinality } }); }
  for (const r of g.refsTo(fqn)) { const s = g.byFqn(r.from); if (s && s.kind === "object" && !nbCandidates.has(r.from)) nbCandidates.set(r.from, { node: s, edge: { parent: dn.name, child: s.name, label: edgeLabelFor(r), cardinality: r.cardinality } }); }
```
First, extend the existing `../link-graph` import at the top of `object-data.ts` to bring in the `Ref` type — change:
```ts
import { LinkGraph, fqnOf } from "../link-graph";
```
to:
```ts
import { LinkGraph, fqnOf, type Ref } from "../link-graph";
```
Then add this helper at module scope (above `buildObjectPage`):
```ts
// Neighborhood edge label: relationship edges show their name + (M:N) junction + onDelete; extends/others show via.
function edgeLabelFor(r: Ref): string {
  if (r.kind === "extends") return "extends";
  if (r.kind === "relationship") {
    const junction = r.through ? ` · M:N via ${r.through.split("::").pop()}` : "";
    const od = r.onDelete ? ` · ${r.onDelete}` : "";
    return `${r.via}${junction}${od}`;
  }
  return r.via;
}
```
The `ErEdge` for the rich diagram is built at the `erNodes`/`erDiagramRich(erNodes, nbEdges)` call — `nbEdges` are the `edge` objects collected above, which now include `cardinality`. No further change needed there (the `edge` objects ARE `ErEdge`-shaped). For the large-neighborhood `flowchartDomain` branch, map the M:N `cardinality` to `style: "dashed"`. Replace:
```ts
      const r = flowchartDomain([...nbNodes.values()].map((n) => ({ name: n.name, pkg: n.pkg, kind: n.node.subType })), nbEdges.map((e) => ({ from: e.parent, to: e.child, label: e.label })));
```
with:
```ts
      const r = flowchartDomain([...nbNodes.values()].map((n) => ({ name: n.name, pkg: n.pkg, kind: n.node.subType })), nbEdges.map((e) => ({ from: e.parent, to: e.child, label: e.label, ...(e.cardinality === "many" ? { style: "dashed" as const } : {}) })));
```

- [ ] **Step 6: Thread `style` through the core diagram in `index-data.ts`.** In `src/builders/index-data.ts`, the `heroEdges` are built as `{ from, to, label: "" }`. Carry cardinality → dashed for M:N. Replace the `heroEdges.push(...)` line:
```ts
    if (!seenEdge.has(key)) { seenEdge.add(key); heroEdges.push({ from: dn.name, to, label: "" }); }
```
with:
```ts
    if (!seenEdge.has(key)) { seenEdge.add(key); heroEdges.push({ from: dn.name, to, label: "", ...(e.cardinality === "many" ? { style: "dashed" as const } : {}) }); }
```
and widen the `heroEdges` declaration type:
```ts
  const heroEdges: { from: string; to: string; label: string; style?: "dashed" }[] = [];
```

- [ ] **Step 7: Run the unit suites.** Run: `bun test test/mermaid.test.ts test/object-data.test.ts test/object-data-v2.test.ts test/graph-v2.test.ts`. Expected: PASS (fix any assertion that pinned an exact old edge string — update it to the enriched label).

- [ ] **Step 8: Regenerate the golden + determinism.** Run the regen command, then `bun test test/golden.test.ts` twice. Expected: PASS both. (Golden diff: M:N edges render `}o--o{` / dashed; relationship labels carry `· cascade` / `· M:N via …`.)

- [ ] **Step 9: Typecheck + commit.**

```bash
bun run typecheck
git add src/mermaid.ts src/builders/object-data.ts src/builders/index-data.ts test/mermaid.test.ts test/fixture/golden
git commit -m "feat(docs-site): render M:N with }o--o{ (ER) + dashed flowchart edge; label onDelete/junction"
```

---

## Task 5: Hygiene — genericize the `CURATED` palette keys

**Files:**
- Modify: `src/mermaid.ts` (`CURATED` keys only — values + order unchanged)
- Modify: `test/fixture/golden/**` (verify byte-identical — must NOT change)

**Interfaces:**
- Produces: `CURATED` keyed by neutral slot names; `PALETTE = Object.values(CURATED)` unchanged (same values, same order) → `domainColor` hashing unchanged → zero golden impact.

- [ ] **Step 1: Rename the `CURATED` keys to neutral slots.** In `src/mermaid.ts`, replace the `CURATED` object so **every value stays identical and in the same order**, only the keys change:

```ts
const CURATED: Record<string, { fill: string; stroke: string; text: string }> = {
  slot1:  { fill: "#1e3a5f", stroke: "#60a5fa", text: "#93c5fd" },
  slot2:  { fill: "#3b2f1e", stroke: "#fbbf24", text: "#fde68a" },
  slot3:  { fill: "#3f2d5c", stroke: "#a78bfa", text: "#ede9fe" },
  slot4:  { fill: "#3f1f2e", stroke: "#fb7185", text: "#fecdd3" },
  slot5:  { fill: "#14342b", stroke: "#34d399", text: "#a7f3d0" },
  slot6:  { fill: "#1f2937", stroke: "#94a3b8", text: "#e2e8f0" },
  slot7:  { fill: "#2a2440", stroke: "#818cf8", text: "#e0e7ff" },
  slot8:  { fill: "#1a2e35", stroke: "#22d3ee", text: "#cffafe" },
  slot9:  { fill: "#332018", stroke: "#fb923c", text: "#fed7aa" },
  slot10: { fill: "#1c2431", stroke: "#64748b", text: "#cbd5e1" },
};
```
(This drops the per-domain-name color feature — acme packages never matched those keys, so behavior for any real model is unchanged: everything now hashes into `PALETTE`.)

- [ ] **Step 2: Confirm the golden is byte-identical.** Run: `bun test test/golden.test.ts`. Expected: PASS with **no regeneration** — the `PALETTE` values/order are unchanged, so colors are identical. If it fails, a value or the order changed — fix it (do not regenerate).

- [ ] **Step 3: Confirm the domain-color tests still pass.** Run: `bun test test/mermaid.test.ts`. Expected: PASS (those tests compute expected colors via `domainColor()`, so key renaming is transparent).

- [ ] **Step 4: Hygiene + commit.**

```bash
# The CURATED keys should now be neutral slotN names only. Eyeball the block:
grep -nE "^\s+slot[0-9]+:" src/mermaid.ts    # expect 10 neutral slot keys, no domain words
grep -rniE "/home/" src/mermaid.ts && echo LEAK || echo clean
bun run typecheck
git add src/mermaid.ts
git commit -m "chore(docs-site): genericize CURATED palette keys (neutral slots; palette values unchanged)"
```

---

## Task 6: Full verification + wrap

**Files:** none (verification only).

- [ ] **Step 1: Full docs-site suite.** Run: `cd server/typescript/packages/docs-site && bun test`. Expected: all pass, 0 fail.

- [ ] **Step 2: Determinism double-check.** Run the regen command, then `git status --short test/fixture/golden` — expected: **no changes** (the committed golden already equals a fresh regeneration). If files change, determinism regressed — investigate before proceeding.

- [ ] **Step 3: Build + typecheck.** Run: `bun run build && bun run typecheck`. Expected: both clean.

- [ ] **Step 4: No-relationship model is unaffected.** Confirm a model without relationship children still renders `||--o{` only:

```bash
bun -e 'import {LinkGraph} from "./src/link-graph.ts"; import {loadModel} from "./src/load.ts"; const m = await loadModel(["test/fixture/input/acme"]); const g = new LinkGraph(m); const orphan = g.refsFrom("acme::shop::OrphanLog"); console.log("OrphanLog edges:", orphan.length, "— expect 0 relationship edges:", orphan.filter((r)=>r.kind==="relationship").length);'
```
Expected: `OrphanLog` (no relationships/FKs) has 0 relationship edges — proves the enrichment is scoped to entities that declare relationships.

- [ ] **Step 5: Hygiene sweep of all touched files.**

```bash
grep -rniE "/home/" src test/fixture/input && echo REVIEW || echo clean
```
Expected: clean.

- [ ] **Step 6: Confirm the commit series.** Run: `git log --oneline main..HEAD`. Expected: the Phase-1 commits + the spec + Tasks 1–5 commits, all present.

---

## Self-Review

**Spec coverage:** M:N-through-junction with junction-as-node → Task 1 fixture + Task 3 + Task 4 rendering; belongs-to cardinality/onDelete/subtype → Task 2; directed + symmetric self-joins → Task 1 fixture + Task 3; relationship-vs-FK dedupe → Task 2; `}o--o{` / dashed rendering → Task 4; consume metadata primitives (no codegen-ts dep) → Task 2 imports + Task 3; extend acme + regenerate golden → every output task; determinism + link-check + golden gates → regen-twice steps + Task 6; escaping preserved → labels routed through `safe()`/`edgeLabel()`; genericize `CURATED` keys → Task 5; no private-name/path leak → per-task grep + Task 6.

**Placeholder scan:** none — every code step shows the exact replacement; the Task-2 `addM2mEdge` stub is explicitly a temporary that Task 3 Step 3 replaces (called out in both tasks).

**Type consistency:** `Ref` fields (`cardinality`/`through`/`sourceJoinField`/`targetJoinField`/`symmetric`/`onDelete`/`subtype`) defined in Task 2 Step 1 and consumed in Tasks 3–4; `ErEdge.cardinality` and the flowchart `style` defined in Task 4 Step 3 and consumed in Task 4 Steps 5–6; `edgeLabelFor(r: Ref)` uses only `Ref` fields; `deriveM2MFields`/`MetaObject`/`MetaRelationship`/`stripPackage` imported in Task 2 Step 2 and used in Tasks 2–3.
