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

  // Rule (d) exception (#368): @sourceRefField also disambiguates a
  // @cardinality:one relationship — which of several identity.reference nodes
  // onto the same target it navigates (see resolve-relationship-reference.test.ts).
  // Only the M:N *junction* reading of @sourceRefField still requires @cardinality:many.
  test("sourceRefField on a cardinality:one relationship loads cleanly (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Match", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "homeTeamId" } },
        { "field.long": { name: "awayTeamId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "homeTeamId" } },
        { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "awayTeamId" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
  });

  test("sourceRefField on a @cardinality:many relationship without @through still errors", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Match", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "relationship.association": { name: "teams", "@objectRef": "Team", "@cardinality": "many", "@sourceRefField": "whatever" } } ] } },
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

// ---------------------------------------------------------------------------
// Rule (e) (#368): a `@cardinality: one` relationship must resolve to exactly
// one identity.reference. Two references onto the same target are
// indistinguishable from @objectRef alone — the resolver used to silently
// emit the first one's FK column, so ambiguity is now a load error naming
// the candidates instead.
// ---------------------------------------------------------------------------

describe("FR-017 Rule (e) — #368 ambiguous 1:N reference resolution", () => {
  test("two references to one target with an unpairable relationship name is a load error (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Match", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "alphaFk" } },
        { "field.long": { name: "betaFk" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "alphaRef", "@fields": ["alphaFk"], "@references": "Team" } },
        { "identity.reference": { name: "betaRef", "@fields": ["betaFk"], "@references": "Team" } },
        { "relationship.association": { name: "winner", "@objectRef": "Team", "@cardinality": "one" } } ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_INVALID_RELATIONSHIP");
    const message = errors.map((e) => e.message).join("\n");
    expect(message).toContain("Match.winner");
    expect(message).toContain("alphaRef(alphaFk)");
    expect(message).toContain("betaRef(betaFk)");
  });

  test("the issue #368 repro loads clean via name pairing", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Match", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "homeTeamId" } },
        { "field.long": { name: "awayTeamId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one" } },
        { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
  });

  test("sourceRefField naming no local reference is a load error (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Match", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "homeTeamId" } },
        { "field.long": { name: "awayTeamId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "nonesuch" } },
        { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "awayTeamId" } } ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_INVALID_RELATIONSHIP");
    const message = errors.map((e) => e.message).join("\n");
    expect(message).toContain("Match.homeTeam");
    expect(message).toContain('"nonesuch"');
    // awayTeam's @sourceRefField correctly names awayTeamRef's FK field — no error for it.
    expect(message).not.toContain("Match.awayTeam");
  });

  // Fix round 1: a declared @sourceRefField naming nothing must error even
  // with exactly one candidate — resolveRelationshipReference's ladder step 1
  // ("exactly one candidate -> that one") would otherwise silently return
  // that lone candidate regardless of whether it matches the declared field,
  // emitting a join on the wrong column with no error at all.
  test("sourceRefField naming nothing with a single candidate is a load error (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Match", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "homeTeamId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "awayTeamId" } } ] } },
    ] } });
    expect(codesOf(errors)).toEqual(["ERR_INVALID_RELATIONSHIP"]);
    const message = errors.map((e) => e.message).join("\n");
    expect(message).toContain("Match.awayTeam");
    expect(message).toContain('"awayTeamId"');
  });

  test("sourceRefField correctly naming the single candidate loads clean (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Match", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "homeTeamId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "homeTeam", "@objectRef": "Team", "@cardinality": "one", "@sourceRefField": "homeTeamId" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
  });

  // Fix round 1: two composite references sharing a first column must still
  // print distinguishably in the candidate list (previously rendered as
  // `fields[0]` only, so both showed as e.g. "aRef(tenantId), bRef(tenantId)").
  // Matching still keys on fields[0] alone (documented limitation) — this is
  // a message-rendering fix only.
  test("composite reference candidates render their full field tuple (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Match", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "tenantId" } },
        { "field.long": { name: "homeTeamId" } },
        { "field.long": { name: "awayTeamId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "aRef", "@fields": ["tenantId", "homeTeamId"], "@references": "Team" } },
        { "identity.reference": { name: "bRef", "@fields": ["tenantId", "awayTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "winner", "@objectRef": "Team", "@cardinality": "one" } } ] } },
    ] } });
    expect(codesOf(errors)).toContain("ERR_INVALID_RELATIONSHIP");
    const message = errors.map((e) => e.message).join("\n");
    expect(message).toContain("aRef(tenantId, homeTeamId)");
    expect(message).toContain("bRef(tenantId, awayTeamId)");
  });

  // Fix round 2: rule (e) must iterate the EFFECTIVE relationship set
  // (obj.relationships(), own + inherited via extends), not ownChildren().
  // A entity declares the relationship + a single reference (clean on its
  // own); B extends A and adds a SECOND reference onto the same target. The
  // relationship is only inherited on B, so an own-scoped pass would never
  // examine it there and this would load clean while codegen/runtime, which
  // resolve against B's effective children, silently drop the relation.
  test("an inherited relationship becomes ambiguous when a child entity adds a second reference (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "A", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "homeTeamId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "winner", "@objectRef": "Team", "@cardinality": "one" } } ] } },
      { "object.entity": { name: "B", "extends": "A", children: [
        { "field.long": { name: "awayTeamId" } },
        { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } } ] } },
    ] } });
    expect(codesOf(errors)).toEqual(["ERR_INVALID_RELATIONSHIP"]);
    const message = errors.map((e) => e.message).join("\n");
    expect(message).toContain("B.winner");
    expect(message).toContain("homeTeamRef(homeTeamId)");
    expect(message).toContain("awayTeamRef(awayTeamId)");
  });

  test("a child entity's added reference that name-pairs with the inherited relationship loads clean (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Team", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "A", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "homeTeamId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "homeTeamRef", "@fields": ["homeTeamId"], "@references": "Team" } },
        { "relationship.association": { name: "awayTeam", "@objectRef": "Team", "@cardinality": "one" } } ] } },
      { "object.entity": { name: "B", "extends": "A", children: [
        { "field.long": { name: "awayTeamId" } },
        { "identity.reference": { name: "awayTeamRef", "@fields": ["awayTeamId"], "@references": "Team" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
  });

  // Fix round 3: validateRelationships (rule (d), the M:N slim-vocabulary
  // pass) also switched to the resolving relationship set for ADR-0039
  // compliance. Unlike rule (e), rule (d)'s checks read only the
  // relationship's own attrs, so an inherited, UNMODIFIED relationship must
  // be reported exactly once no matter how many entities inherit it — this
  // is the dedup guard, not a "different entity, different finding" case.
  test("an inherited rule-(d) violation is reported once, not once per inheriting entity (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Program", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "A", children: [
        { "field.long": { name: "id" } },
        { "relationship.composition": { name: "program", "@objectRef": "Program",
            "@cardinality": "one", "@through": "X" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "B", "extends": "A" } },
    ] } });
    expect(codesOf(errors)).toEqual(["ERR_INVALID_RELATIONSHIP"]);
  });

  test("an inherited rule-(d) violation stays a single error across several inheriting children (#368)", async () => {
    const { errors } = await loadDoc({ "metadata.root": { package: "repro", children: [
      { "object.entity": { name: "Program", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "A", children: [
        { "field.long": { name: "id" } },
        { "relationship.composition": { name: "program", "@objectRef": "Program",
            "@cardinality": "one", "@through": "X" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "B", "extends": "A" } },
      { "object.entity": { name: "C", "extends": "A" } },
      { "object.entity": { name: "D", "extends": "A" } },
    ] } });
    expect(codesOf(errors)).toEqual(["ERR_INVALID_RELATIONSHIP"]);
  });
});

// ---------------------------------------------------------------------------
// Two latent "obj vs. declaring entity" bugs, backfilled from the C#/Java
// ports (see Issue368RelationshipReferenceValidationTests.cs and
// Issue368RelationshipReferenceValidationTest.java). Both bugs are
// ORDER-DEPENDENT: they only manifest when an inheriting entity is visited
// by validateRelationships's outer loop BEFORE its declaring base — which is
// why neither was caught by the tests above when the #368 fix landed here
// (`const declaringEntity = rel.parent ?? obj;` in validation-passes.ts).
// Each fixture pins the visit-order invariant it depends on via
// `objectVisitOrder`, so a future change to iteration order fails loudly
// instead of silently making the test pass for the wrong reason.
// ---------------------------------------------------------------------------

describe("FR-017 #368 order-dependence regressions (declaring entity vs. visiting entity)", () => {
  function objectVisitOrder(root: { children(): readonly { type: string; resolutionKey(): string }[] }): string[] {
    return root.children().filter((c) => c.type === TYPE_OBJECT).map((o) => o.resolutionKey());
  }

  test("inherited self-join relationship is not misflagged as non-self-join", async () => {
    // Node extends NodeBase, which declares a @symmetric self-join relationship
    // onto NodeBase itself (@objectRef: "NodeBase"). Node is declared BEFORE
    // NodeBase (extends is resolved order-independently by a deferred pass, so
    // this is legal) so that the outer validation loop visits `obj = Node`
    // FIRST — if rule (a)'s self-join comparison used the visiting `obj`
    // instead of the relationship's DECLARING entity (NodeBase, via rel.parent),
    // it would wrongly conclude @objectRef "NodeBase" is not the (visiting)
    // declaring entity "Node" and misfire ERR_BAD_ATTR_VALUE.
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Node", "extends": "NodeBase", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "NodeBase", abstract: true, children: [
        { "relationship.association": { name: "peers", "@cardinality": "many", "@objectRef": "NodeBase",
            "@through": "NodeLink", "@symmetric": true } } ] } },
      { "object.entity": { name: "NodeLink", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "aId" } },
        { "field.long": { name: "bId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "a", "@fields": ["aId"], "@references": "NodeBase" } },
        { "identity.reference": { name: "b", "@fields": ["bId"], "@references": "NodeBase" } } ] } },
    ] } });
    // Pin the iteration-order invariant this test's premise depends on: if
    // root.children() ever stopped iterating in declaration order (e.g. started
    // sorting alphabetically), "Node" would no longer be visited before
    // "NodeBase" and this test would keep passing for the wrong reason —
    // silently no longer exercising the bug at all. Fail loudly instead.
    expect(objectVisitOrder(root)).toEqual(["acme::Node", "acme::NodeBase", "acme::NodeLink"]);
    expect(codesOf(errors)).not.toContain("ERR_BAD_ATTR_VALUE");
    expect(codesOf(errors)).not.toContain("ERR_INVALID_RELATIONSHIP");
  });

  test("inherited bare @through resolves in the declaring entity's package, not the visiting one", async () => {
    // WeekBase (package "base") declares a M:N relationship with a BARE
    // @through "Tag" — ADR-0042 says a bare ref resolves in the DECLARING
    // entity's package ("base::Tag"), never the package of whichever entity
    // inherits and visits it. Week extends WeekBase from a DIFFERENT package
    // ("acme") that also happens to declare its own unrelated "Tag" entity.
    // The acme source is loaded FIRST so the outer validation loop visits
    // `obj = Week` before `obj = WeekBase` — if @through resolution used
    // the visiting entity's package it would wrongly bind to "acme::Tag"
    // (which has zero identity.reference children) instead of "base::Tag"
    // (which correctly has two).
    const acmeDoc = { "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Week", "extends": "base::WeekBase", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
    ] } };
    const baseDoc = { "metadata.root": { package: "base", children: [
      { "object.entity": { name: "WeekBase", abstract: true, children: [
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag", "@through": "Tag" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "weekId" } },
        { "field.long": { name: "labelId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "w", "@fields": ["weekId"], "@references": "base::WeekBase" } },
        { "identity.reference": { name: "l", "@fields": ["labelId"], "@references": "base::Tag" } } ] } },
    ] } };
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(acmeDoc), { id: "acme.json" }),
      new InMemoryStringSource(JSON.stringify(baseDoc), { id: "base.json" }),
    ]);
    // Pin the iteration-order invariant: the acme source must be fully visited
    // (Week, then acme::Tag) before base's WeekBase/Tag, or this test's premise
    // (obj = Week visited before obj = WeekBase) silently stops holding and the
    // test would keep passing without ever exercising the bug.
    expect(objectVisitOrder(root)).toEqual(["acme::Week", "acme::Tag", "base::WeekBase", "base::Tag"]);
    expect(codesOf(errors)).not.toContain("ERR_INVALID_RELATIONSHIP");
  });
});

// ---------------------------------------------------------------------------
// deriveM2MFields — declaring entity vs. visiting entity (the #368 follow-up).
//
// Same confusion as the two regressions above, one layer down: the derivation
// classified the self-join, and matched the hetero junction reference, against
// the `source` entity its CALLER passed. Every caller walks the RESOLVING
// `obj.relationships()` (codegen-ts's relation-resolver, runtime-ts's
// n2m-resolver, docs-site's link-graph, and their Java/C#/Python twins) and
// passes the entity it is iterating — so for a relationship inherited via
// `extends` that is the INHERITING entity, not the one that declared it.
//
// Unlike the loader-pass regressions above, this defect is NOT gated on visit
// order: there is no once-per-node `checked` set here, so the derivation is
// simply wrong for every inheriting entity, whichever order they are reached
// in. The fixtures still declare the child BEFORE the base and pin the visit
// order, matching the #368 convention and covering the order-sensitive shape
// for free.
// ---------------------------------------------------------------------------

describe("FR-017 deriveM2MFields uses the DECLARING entity, not the visiting one", () => {
  function objectVisitOrder(root: { children(): readonly { type: string; resolutionKey(): string }[] }): string[] {
    return root.children().filter((c) => c.type === TYPE_OBJECT).map((o) => o.resolutionKey());
  }

  test("inherited symmetric self-join derives both FK sides (was: read as hetero, threw)", async () => {
    // NodeBase declares a @symmetric self-join onto itself; Node extends it and
    // is declared FIRST. Reached through Node's effective view, the derivation
    // used to compare @objectRef "NodeBase" against the VISITING "Node",
    // conclude "not a self-join", take the hetero branch, look for a junction
    // reference to "Node" (there is none — both point at NodeBase) and throw
    // M2MDerivationError. Codegen swallows that throw, so the navigation just
    // vanished from the generated output.
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Node", "extends": "NodeBase", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "NodeBase", abstract: true, children: [
        { "relationship.association": { name: "peers", "@cardinality": "many", "@objectRef": "NodeBase",
            "@through": "NodeLink", "@symmetric": true } } ] } },
      { "object.entity": { name: "NodeLink", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "aId" } },
        { "field.long": { name: "bId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "a", "@fields": ["aId"], "@references": "NodeBase" } },
        { "identity.reference": { name: "b", "@fields": ["bId"], "@references": "NodeBase" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
    expect(objectVisitOrder(root)).toEqual(["acme::Node", "acme::NodeBase", "acme::NodeLink"]);

    const node = findObj(root, "Node");
    // RESOLVING accessor — this is exactly what every caller walks, and it is
    // what surfaces the inherited relationship on the child.
    const rel = node.relationships().find((r) => r.name === "peers") as MetaRelationship;
    expect(node.ownRelationships()).toHaveLength(0);
    expect(rel.parent?.name).toBe("NodeBase");

    const derived = deriveM2MFields(rel, node, root);
    expect(derived.sourceField).toBe("aId");
    expect(derived.targetField).toBe("bId");
    // And the declaring entity itself must still agree — same node, same answer.
    expect(deriveM2MFields(rel, findObj(root, "NodeBase"), root)).toEqual(derived);
  });

  test("inherited directed self-join honours @sourceRefField through the child's view", async () => {
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Person", "extends": "PartyBase", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "PartyBase", abstract: true, children: [
        { "relationship.association": { name: "follows", "@cardinality": "many", "@objectRef": "PartyBase",
            "@through": "Follow", "@sourceRefField": "followerId" } } ] } },
      { "object.entity": { name: "Follow", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "followerId" } },
        { "field.long": { name: "followeeId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "followerRef", "@fields": ["followerId"], "@references": "PartyBase" } },
        { "identity.reference": { name: "followeeRef", "@fields": ["followeeId"], "@references": "PartyBase" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
    expect(objectVisitOrder(root)).toEqual(["acme::Person", "acme::PartyBase", "acme::Follow"]);

    const person = findObj(root, "Person");
    const rel = person.relationships().find((r) => r.name === "follows") as MetaRelationship;
    const derived = deriveM2MFields(rel, person, root);
    expect(derived.sourceField).toBe("followerId");
    expect(derived.targetField).toBe("followeeId");
  });

  test("inherited HETERO M:N matches the junction reference to the declaring base", async () => {
    // The mirror image: the junction references the DECLARING base (ArticleBase),
    // so a hetero match against the visiting child (Article) found nothing and
    // threw the "must declare one identity.reference to ..." error.
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Article", "extends": "ArticleBase", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "ArticleBase", abstract: true, children: [
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag",
            "@through": "ArticleTag" } } ] } },
      { "object.entity": { name: "Tag", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "ArticleTag", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "articleId" } },
        { "field.long": { name: "tagId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "articleRef", "@fields": ["articleId"], "@references": "ArticleBase" } },
        { "identity.reference": { name: "tagRef", "@fields": ["tagId"], "@references": "Tag" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
    expect(objectVisitOrder(root)).toEqual(["acme::Article", "acme::ArticleBase", "acme::Tag", "acme::ArticleTag"]);

    const article = findObj(root, "Article");
    const rel = article.relationships().find((r) => r.name === "tags") as MetaRelationship;
    const derived = deriveM2MFields(rel, article, root);
    expect(derived.sourceField).toBe("articleId");
    expect(derived.targetField).toBe("tagId");
  });

  test("inherited HETERO whose junction references the CONCRETE child still derives", async () => {
    // The other legitimate authoring shape, and the common one: the base is
    // abstract (no table), so the junction FK references the CONCRETE entity.
    // Both names — the declaring base and the navigating child — must be
    // accepted as the relationship's subject, or fixing the base-referencing
    // shape would break this one. Pinned by
    // python/tests/unit/test_n2m_resolver_inherited.py, which is authored this way.
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Post", "extends": "PostBase", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "PostBase", abstract: true, children: [
        { "relationship.association": { name: "tags", "@cardinality": "many", "@objectRef": "Tag",
            "@through": "PostTag" } } ] } },
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
    const post = findObj(root, "Post");
    const rel = post.relationships().find((r) => r.name === "tags") as MetaRelationship;
    expect(rel.parent?.name).toBe("PostBase");
    const derived = deriveM2MFields(rel, post, root);
    expect(derived.sourceField).toBe("postId");
    expect(derived.targetField).toBe("tagId");
  });

  // REGRESSION — a cross-package hetero M:N must not be read as a self-join just
  // because the target's SHORT name matches one of the subject's.
  //
  // `a::NodeBase` declares a genuine cross-package hetero M:N onto `b::NodeBase`,
  // and `a::Node extends a::NodeBase`. Deriving from `a::Node` the subject is
  // {a::NodeBase, a::Node}; under the old stripPackage() compare "b::NodeBase"
  // stripped to "NodeBase", landed in the subject set, and the relationship
  // refused to derive as an ambiguous self-join. It had derived correctly before
  // the subject set grew to two names, so that was a regression, not a
  // pre-existing gap.
  //
  // Fixed by comparing RESOLVED OBJECT IDENTITY, which is what the Java port has
  // always done — this is the TS half of the pair with
  // M2MSlimVocabularyTest.deriveCrossPackageHeteroBindsCorrectPackage, and it
  // REDUCES the cross-port divergence rather than pinning it.
  //
  // The junction's SOURCE reference names the DECLARING BASE ("a::NodeBase") — the
  // shape docs/features/relationships.md blesses, and the one whose short name
  // collides with the target's. That matters: making isSelfJoin identity-based
  // while the hetero TARGET search was still a bare compare let that search
  // re-match this very reference (nothing excludes sourceRef from it, unlike the
  // directed self-join branch) and return (srcId, srcId) silently. Both searches
  // are identity-based now, as in Java.
  test("a cross-package hetero target sharing a subject short name is NOT a self-join", async () => {
    const aDoc = { "metadata.root": { package: "a", children: [
      { "object.entity": { name: "Node", "extends": "a::NodeBase", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "NodeBase", abstract: true, children: [
        { "relationship.association": { name: "links", "@cardinality": "many",
            "@objectRef": "b::NodeBase", "@through": "L" } } ] } },
      { "object.entity": { name: "L", children: [
        { "field.long": { name: "srcId" } },
        { "field.long": { name: "dstId" } },
        { "identity.primary": { "name": "id", "@fields": ["srcId", "dstId"] } },
        { "identity.reference": { name: "s", "@fields": ["srcId"], "@references": "a::NodeBase" } },
        { "identity.reference": { name: "d", "@fields": ["dstId"], "@references": "b::NodeBase" } } ] } },
    ] } };
    const bDoc = { "metadata.root": { package: "b", children: [
      { "object.entity": { name: "NodeBase", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
    ] } };
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(aDoc), { id: "a.json" }),
      new InMemoryStringSource(JSON.stringify(bDoc), { id: "b.json" }),
    ]);
    // The model itself is perfectly legal — the loader raises nothing.
    expect(errors).toHaveLength(0);
    expect(objectVisitOrder(root)).toEqual(["a::Node", "a::NodeBase", "a::L", "b::NodeBase"]);

    const node = findObj(root, "Node");
    const rel = node.relationships().find((r) => r.name === "links") as MetaRelationship;
    // Identity resolution binds "b::NodeBase" to the b-package entity, which is
    // neither subject — so this stays hetero and derives, exactly as Java does.
    const derived = deriveM2MFields(rel, node, root);
    expect(derived.sourceField).toBe("srcId");
    expect(derived.targetField).toBe("dstId");
  });

  // Java's deriveCrossPackageHeteroBindsCorrectPackage model, ported. No inheritance
  // is needed to reach the same defect: `a::Account` relates to `b::Account` through a
  // junction holding one reference to each. The two junction searches are INDEPENDENT,
  // so a bare-name target match found `ownerRef` a second time and returned
  // (ownerId, ownerId). Measured before the fix; pre-branch it threw loudly instead.
  test("cross-package hetero matches each junction reference to its OWN entity", async () => {
    const aDoc = { "metadata.root": { package: "a", children: [
      { "object.entity": { name: "Account", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "partners", "@cardinality": "many",
            "@objectRef": "b::Account", "@through": "AccountLink" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "AccountLink", children: [
        { "field.long": { name: "ownerId" } },
        { "field.long": { name: "partnerId" } },
        { "identity.primary": { "name": "id", "@fields": ["ownerId", "partnerId"] } },
        { "identity.reference": { name: "ownerRef", "@fields": ["ownerId"], "@references": "a::Account" } },
        { "identity.reference": { name: "partnerRef", "@fields": ["partnerId"], "@references": "b::Account" } } ] } },
    ] } };
    const bDoc = { "metadata.root": { package: "b", children: [
      { "object.entity": { name: "Account", children: [
        { "field.long": { name: "id" } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
    ] } };
    const { root, errors } = await new MetaDataLoader().load([
      new InMemoryStringSource(JSON.stringify(aDoc), { id: "a.json" }),
      new InMemoryStringSource(JSON.stringify(bDoc), { id: "b.json" }),
    ]);
    expect(errors).toHaveLength(0);
    const account = root.objects().find((o) => o.resolutionKey() === "a::Account")!;
    const rel = account.relationships().find((r) => r.name === "partners") as MetaRelationship;
    const derived = deriveM2MFields(rel, account, root);
    expect(derived.sourceField).toBe("ownerId");
    expect(derived.targetField).toBe("partnerId");   // was "ownerId"
  });

  test("an OWN relationship still derives against its own entity (no regression)", async () => {
    // The override case: Sub re-declares `peers` itself, so rel.parent IS Sub and
    // the self-join must be classified against Sub, not the base it shadows.
    const { root, errors } = await loadDoc({ "metadata.root": { package: "acme", children: [
      { "object.entity": { name: "Sub", "extends": "Base", children: [
        { "field.long": { name: "id" } },
        { "relationship.association": { name: "peers", "@cardinality": "many", "@objectRef": "Sub",
            "@through": "SubLink", "@symmetric": true } },
        { "identity.primary": { "name": "id", "@fields": "id" } } ] } },
      { "object.entity": { name: "Base", abstract: true, children: [
        { "relationship.association": { name: "peers", "@cardinality": "many", "@objectRef": "Base",
            "@through": "BaseLink", "@symmetric": true } } ] } },
      { "object.entity": { name: "SubLink", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "leftId" } },
        { "field.long": { name: "rightId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "l", "@fields": ["leftId"], "@references": "Sub" } },
        { "identity.reference": { name: "r", "@fields": ["rightId"], "@references": "Sub" } } ] } },
      { "object.entity": { name: "BaseLink", children: [
        { "field.long": { name: "id" } },
        { "field.long": { name: "aId" } },
        { "field.long": { name: "bId" } },
        { "identity.primary": { "name": "id", "@fields": "id" } },
        { "identity.reference": { name: "a", "@fields": ["aId"], "@references": "Base" } },
        { "identity.reference": { name: "b", "@fields": ["bId"], "@references": "Base" } } ] } },
    ] } });
    expect(errors).toHaveLength(0);
    const sub = findObj(root, "Sub");
    const rel = sub.relationships().find((r) => r.name === "peers") as MetaRelationship;
    expect(rel.parent?.name).toBe("Sub");
    const derived = deriveM2MFields(rel, sub, root);
    expect(derived.sourceField).toBe("leftId");
    expect(derived.targetField).toBe("rightId");
  });
});
