// FR-017 Unit 1 — M:N slim vocabulary (through / sourceRefField / symmetric),
// junction-derived FK fields, and M:N validation rules.

import { describe, expect, test } from "bun:test";
import { MetaDataLoader } from "../src/loader/meta-data-loader.js";
import { InMemoryStringSource } from "../src/loader/meta-data-source.js";
import { canonicalSerialize } from "../src/serializer-json.js";
import type { MetaObject } from "../src/core/object/meta-object.js";
import type { MetaRelationship } from "../src/core/relationship/meta-relationship.js";
import { TYPE_OBJECT } from "../src/shared/base-types.js";
import { deriveM2MFields, M2MDerivationError } from "../src/core/relationship/derive-m2m-fields.js";

async function loadDoc(doc: unknown) {
  return new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(doc))]);
}
const codesOf = (errors: readonly Error[]) => errors.map((e) => (e as { code?: string }).code);

function findObj(
  root: { ownChildren(): readonly { type: string; name: string }[] },
  name: string,
): MetaObject {
  return root.ownChildren().find((c) => c.type === TYPE_OBJECT && c.name === name) as unknown as MetaObject;
}

// ---------------------------------------------------------------------------
// Step 1 — constants + schema (slim vocabulary)
// ---------------------------------------------------------------------------

describe("FR-017 M:N slim vocabulary", () => {
  test("association with @cardinality:many + @objectRef + @through loads cleanly", async () => {
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Post", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "PostTag", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "postId" } },
        { "field.long": { name: "tagId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "postRef", "@fields": ["postId"], "@references": "Post" } },
        { "identity.reference": { name: "tagRef", "@fields": ["tagId"], "@references": "Tag" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
    const out = canonicalSerialize(root);
    expect(out).toContain('"@through": "PostTag"');
  });

  test("@joinEntity / @joinFields are no longer schema-known attrs (no through getter)", async () => {
    // The metamodel uses an open attr policy: undeclared @-attrs are preserved
    // verbatim, not rejected. The contract change is that they are no longer
    // part of the relationship vocabulary — `@through` is. So a relationship
    // authored with the OLD attrs has no `through` (M:N is unconfigured).
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Post", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag",
            "@joinEntity": "PostTag", "@joinFields": ["postId", "tagId"] } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
    const post = findObj(root, "Post");
    const rel = post.ownRelationships()[0] as MetaRelationship;
    expect(rel.through).toBeUndefined();
  });

  test("getters expose through / sourceRefField / symmetric; joinFields getter gone", async () => {
    const { root } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "User", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "follows", "@cardinality": "many", "@objectRef": "User",
            "@through": "Follow", "@sourceRefField": "followerId" } },
        { "relationship.association": { name: "friends", "@cardinality": "many", "@objectRef": "User",
            "@through": "Friendship", "@symmetric": true } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
    ] } });
    const user = findObj(root, "User");
    const rels = user.ownRelationships() as MetaRelationship[];
    const follows = rels.find((r) => r.name === "follows")!;
    const friends = rels.find((r) => r.name === "friends")!;
    expect(follows.through).toBe("Follow");
    expect(follows.sourceRefField).toBe("followerId");
    expect(follows.symmetric).toBe(false);
    expect(friends.symmetric).toBe(true);
    expect(friends.sourceRefField).toBeUndefined();
    // joinFields getter no longer exists on the class.
    expect("joinFields" in follows).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Step 2 — derivation helper
// ---------------------------------------------------------------------------

describe("FR-017 deriveM2MFields", () => {
  test("hetero (S != T): derives sourceField / targetField from the junction references", async () => {
    const { root } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Post", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "PostTag", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "postId" } },
        { "field.long": { name: "tagId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "postRef", "@fields": ["postId"], "@references": "Post" } },
        { "identity.reference": { name: "tagRef", "@fields": ["tagId"], "@references": "Tag" } } ] } },
    ] } });
    const post = findObj(root, "Post");
    const rel = post.ownRelationships()[0] as MetaRelationship;
    const derived = deriveM2MFields(rel, post, root);
    expect(derived.sourceField).toBe("postId");
    expect(derived.targetField).toBe("tagId");
  });

  // Regression: @through is written FULLY-QUALIFIED (package::name), same as
  // the loader's own FQN-aware validation accepts (refMatchesObject). Before
  // the fix, deriveM2MFields resolved the junction via the bare-name-only
  // root.findObject and threw M2MDerivationError for every FQN @through, even
  // though the model loads cleanly. Mirrors resolvedTargetPkField's FQN
  // fallback (meta-identity.ts).
  test("hetero with a fully-qualified @through resolves the junction (not just a bare name)", async () => {
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme::shop", children: [
      { "object.entity": { name: "Post", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "acme::shop::Tag", "@through": "acme::shop::PostTag" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "PostTag", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "postId" } },
        { "field.long": { name: "tagId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "postRef", "@fields": ["postId"], "@references": "acme::shop::Post" } },
        { "identity.reference": { name: "tagRef", "@fields": ["tagId"], "@references": "acme::shop::Tag" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
    const post = findObj(root, "Post");
    const rel = post.ownRelationships()[0] as MetaRelationship;
    expect(rel.through).toBe("acme::shop::PostTag");
    const derived = deriveM2MFields(rel, post, root);
    expect(derived.sourceField).toBe("postId");
    expect(derived.targetField).toBe("tagId");
  });

  test("directed self-join: @sourceRefField names the source side; the other ref is the target", async () => {
    const { root } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "User", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "follows", "@cardinality": "many", "@objectRef": "User",
            "@through": "Follow", "@sourceRefField": "followerId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Follow", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "followerId" } },
        { "field.long": { name: "followeeId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "followerRef", "@fields": ["followerId"], "@references": "User" } },
        { "identity.reference": { name: "followeeRef", "@fields": ["followeeId"], "@references": "User" } } ] } },
    ] } });
    const user = findObj(root, "User");
    const rel = user.ownRelationships()[0] as MetaRelationship;
    const derived = deriveM2MFields(rel, user, root);
    expect(derived.sourceField).toBe("followerId");
    expect(derived.targetField).toBe("followeeId");
  });

  test("symmetric self-join: both directions derived; sourceField is the first ref", async () => {
    const { root } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "User", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "friends", "@cardinality": "many", "@objectRef": "User",
            "@through": "Friendship", "@symmetric": true } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Friendship", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "userAId" } },
        { "field.long": { name: "userBId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "aRef", "@fields": ["userAId"], "@references": "User" } },
        { "identity.reference": { name: "bRef", "@fields": ["userBId"], "@references": "User" } } ] } },
    ] } });
    const user = findObj(root, "User");
    const rel = user.ownRelationships()[0] as MetaRelationship;
    const derived = deriveM2MFields(rel, user, root);
    expect(derived.sourceField).toBe("userAId");
    expect(derived.targetField).toBe("userBId");
  });

  test("ambiguous self-join (no sourceRefField, no symmetric) → M2MDerivationError", async () => {
    const { root } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "User", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "related", "@cardinality": "many", "@objectRef": "User",
            "@through": "UserLink" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "UserLink", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "aId" } },
        { "field.long": { name: "bId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "aRef", "@fields": ["aId"], "@references": "User" } },
        { "identity.reference": { name: "bRef", "@fields": ["bId"], "@references": "User" } } ] } },
    ] } });
    const user = findObj(root, "User");
    const rel = user.ownRelationships()[0] as MetaRelationship;
    expect(() => deriveM2MFields(rel, user, root)).toThrow(M2MDerivationError);
  });
});

// ---------------------------------------------------------------------------
// Step 3 — validation rules
// ---------------------------------------------------------------------------

describe("FR-017 M:N validation rules", () => {
  // Rule (a): @symmetric:true valid only on a self-join (objectRef == declaring entity).
  test("symmetric on a hetero relationship → ERR_BAD_ATTR_VALUE", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Post", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag",
            "@through": "PostTag", "@symmetric": true } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } }, { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "PostTag", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "postId" } }, { "field.long": { name: "tagId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "p", "@fields": ["postId"], "@references": "Post" } },
        { "identity.reference": { name: "t", "@fields": ["tagId"], "@references": "Tag" } } ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });

  // Rule (b): @symmetric + @sourceRefField mutually exclusive.
  test("symmetric + sourceRefField → ERR_BAD_ATTR_VALUE", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "User", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "friends", "@cardinality": "many", "@objectRef": "User",
            "@through": "Friendship", "@symmetric": true, "@sourceRefField": "userAId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Friendship", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "userAId" } }, { "field.long": { name: "userBId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "a", "@fields": ["userAId"], "@references": "User" } },
        { "identity.reference": { name: "b", "@fields": ["userBId"], "@references": "User" } } ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_BAD_ATTR_VALUE");
  });

  // Rule (c): @through must name an entity declaring two identity.reference children.
  test("through names a junction without two references → ERR_INVALID_RELATIONSHIP", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Post", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } }, { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "PostTag", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "postId" } }, { "field.long": { name: "tagId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "p", "@fields": ["postId"], "@references": "Post" } } ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_INVALID_RELATIONSHIP");
  });

  // Rule (c continued): @sourceRefField must match one of the junction references' FK fields.
  test("sourceRefField not matching any junction reference → ERR_INVALID_RELATIONSHIP", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "User", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "follows", "@cardinality": "many", "@objectRef": "User",
            "@through": "Follow", "@sourceRefField": "nope" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Follow", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "followerId" } }, { "field.long": { name: "followeeId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "a", "@fields": ["followerId"], "@references": "User" } },
        { "identity.reference": { name: "b", "@fields": ["followeeId"], "@references": "User" } } ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_INVALID_RELATIONSHIP");
  });

  // Rule (d): M:N attrs invalid on a 1:N (no @through / @cardinality:one) relationship.
  test("through on a @cardinality:one relationship → ERR_INVALID_RELATIONSHIP", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Week", children: [
        { "field.long": { name: "id" } },
        { "relationship.composition": { name: "program", "@objectRef": "Program",
            "@cardinality": "one", "@through": "X" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Program", children: [
        { "field.long": { name: "id" } }, { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_INVALID_RELATIONSHIP");
  });

  test("symmetric on a 1:N relationship → ERR_INVALID_RELATIONSHIP", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Week", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "program", "@objectRef": "Program", "@symmetric": true } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Program", children: [
        { "field.long": { name: "id" } }, { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_INVALID_RELATIONSHIP");
  });

  test("valid hetero M:N produces no relationship errors", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Post", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "PostTag" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } }, { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "PostTag", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "postId" } }, { "field.long": { name: "tagId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "p", "@fields": ["postId"], "@references": "Post" } },
        { "identity.reference": { name: "t", "@fields": ["tagId"], "@references": "Tag" } } ] } },
    ] } });
    expect(codesOf(errors)).not.toContain("ERR_INVALID_RELATIONSHIP");
    expect(codesOf(errors)).not.toContain("ERR_BAD_ATTR_VALUE");
  });
});
