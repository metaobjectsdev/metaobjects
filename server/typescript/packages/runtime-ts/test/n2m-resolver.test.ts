// M:N resolver — three modes (hetero, directed self-join, symmetric union),
// all driven off the slim FR-017 vocabulary (@through + junction
// identity.reference children). No @joinEntity / @joinFields anywhere.

import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaRoot } from "@metaobjectsdev/metadata";
import { resolveN2mDescriptor, buildN2mLazySpecs, buildN2mBatchSpecs } from "../src/n2m-resolver.js";

async function load(meta: unknown): Promise<MetaRoot> {
  const res = await new MetaDataLoader().load([new InMemoryStringSource(JSON.stringify(meta))]);
  expect(res.errors).toEqual([]);
  return res.root;
}

function entity(name: string, fields: string[], extra: unknown[] = []): unknown {
  return {
    "object.entity": {
      name,
      children: [
        ...fields.map((f) => ({ "field.long": { name: f } })),
        ...extra,
      ],
    },
  };
}

function primary(...f: string[]): unknown {
  return { "identity.primary": { name: "primary", "@fields": f } };
}
function reference(name: string, fk: string, target: string): unknown {
  return { "identity.reference": { name, "@fields": [fk], "@references": target } };
}
function relMany(name: string, objectRef: string, through: string, extra: Record<string, unknown> = {}): unknown {
  return { "relationship.association": { name, "@cardinality": "many", "@objectRef": objectRef, "@through": through, ...extra } };
}

// ---------------------------------------------------------------------------
// Mode 1 — hetero (Post —tags→ Tag via PostTag)
// ---------------------------------------------------------------------------

const HETERO = {
  "metadata.root": {
    package: "demo",
    children: [
      entity("Post", ["id", "title"], [
        primary("id"),
        relMany("tags", "Tag", "PostTag"),
      ]),
      entity("Tag", ["id", "name"], [primary("id")]),
      entity("PostTag", ["postId", "tagId"], [
        primary("postId", "tagId"),
        reference("postRef", "postId", "Post"),
        reference("tagRef", "tagId", "Tag"),
      ]),
    ],
  },
};

describe("hetero M:N — Post.tags via PostTag", () => {
  test("descriptor derives FK fields from junction references", async () => {
    const root = await load(HETERO);
    const post = root.ownChildByName("Post")!;
    const desc = resolveN2mDescriptor(post, "tags", root)!;
    expect(desc).not.toBeNull();
    expect(desc.targetEntityName).toBe("Tag");
    expect(desc.joinEntityName).toBe("PostTag");
    expect(desc.sourceJoinField).toBe("postId");
    expect(desc.targetJoinField).toBe("tagId");
    expect(desc.symmetric).toBe(false);
  });

  test("non-M:N relationship → null", async () => {
    const root = await load(HETERO);
    const post = root.ownChildByName("Post")!;
    expect(resolveN2mDescriptor(post, "missing", root)).toBeNull();
  });

  test("lazy specs: join WHERE postId = X, then target WHERE id IN (tag ids)", async () => {
    const root = await load(HETERO);
    const post = root.ownChildByName("Post")!;
    const desc = resolveN2mDescriptor(post, "tags", root)!;
    const { joinSpec, makeTargetSpec } = buildN2mLazySpecs(desc, { id: 42 }, root);
    expect(joinSpec.table).toBe("post_tags");
    expect(joinSpec.where).toEqual({ kind: "eq", column: "post_id", value: 42 });
    const targetSpec = makeTargetSpec([{ post_id: 42, tag_id: 1 }, { post_id: 42, tag_id: 2 }]);
    expect(targetSpec!.table).toBe("tags");
    expect(targetSpec!.where).toEqual({ kind: "in", column: "id", values: [1, 2] });
  });

  test("makeTargetSpec returns null when no join rows match", async () => {
    const root = await load(HETERO);
    const post = root.ownChildByName("Post")!;
    const desc = resolveN2mDescriptor(post, "tags", root)!;
    expect(buildN2mLazySpecs(desc, { id: 42 }, root).makeTargetSpec([])).toBeNull();
  });

  test("batch specs: join WHERE postId IN (...)", async () => {
    const root = await load(HETERO);
    const post = root.ownChildByName("Post")!;
    const desc = resolveN2mDescriptor(post, "tags", root)!;
    const { joinSpec } = buildN2mBatchSpecs(desc, [{ id: 1 }, { id: 2 }], root);
    expect(joinSpec.where).toEqual({ kind: "in", column: "post_id", values: [1, 2] });
  });
});

// ---------------------------------------------------------------------------
// Mode 2 — directed self-join (User —follows→ User via Follow, @sourceRefField)
// ---------------------------------------------------------------------------

const DIRECTED = {
  "metadata.root": {
    package: "demo",
    children: [
      entity("User", ["id", "name"], [
        primary("id"),
        relMany("following", "User", "Follow", { "@sourceRefField": "followerId" }),
      ]),
      entity("Follow", ["followerId", "followeeId"], [
        primary("followerId", "followeeId"),
        reference("followerRef", "followerId", "User"),
        reference("followeeRef", "followeeId", "User"),
      ]),
    ],
  },
};

describe("directed self-join — User.following via Follow", () => {
  test("@sourceRefField picks the source FK; the other reference is the target", async () => {
    const root = await load(DIRECTED);
    const user = root.ownChildByName("User")!;
    const desc = resolveN2mDescriptor(user, "following", root)!;
    expect(desc.sourceJoinField).toBe("followerId");
    expect(desc.targetJoinField).toBe("followeeId");
    expect(desc.symmetric).toBe(false);
  });

  test("traversal: join WHERE followerId = X, target WHERE id IN (followeeIds)", async () => {
    const root = await load(DIRECTED);
    const user = root.ownChildByName("User")!;
    const desc = resolveN2mDescriptor(user, "following", root)!;
    const { joinSpec, makeTargetSpec } = buildN2mLazySpecs(desc, { id: 1 }, root);
    expect(joinSpec.where).toEqual({ kind: "eq", column: "follower_id", value: 1 });
    const targetSpec = makeTargetSpec([{ follower_id: 1, followee_id: 2 }, { follower_id: 1, followee_id: 3 }]);
    expect(targetSpec!.where).toEqual({ kind: "in", column: "id", values: [2, 3] });
  });
});

// ---------------------------------------------------------------------------
// Mode 3 — symmetric self-join (User —friends→ User via Friendship, @symmetric)
// ---------------------------------------------------------------------------

const SYMMETRIC = {
  "metadata.root": {
    package: "demo",
    children: [
      entity("User", ["id", "name"], [
        primary("id"),
        relMany("friends", "User", "Friendship", { "@symmetric": true }),
      ]),
      entity("Friendship", ["userAId", "userBId"], [
        primary("userAId", "userBId"),
        reference("aRef", "userAId", "User"),
        reference("bRef", "userBId", "User"),
      ]),
    ],
  },
};

describe("symmetric self-join — User.friends via Friendship (union on read)", () => {
  test("descriptor marks symmetric", async () => {
    const root = await load(SYMMETRIC);
    const user = root.ownChildByName("User")!;
    const desc = resolveN2mDescriptor(user, "friends", root)!;
    expect(desc.symmetric).toBe(true);
    expect(desc.sourceJoinField).toBe("userAId");
    expect(desc.targetJoinField).toBe("userBId");
  });

  test("join WHERE userAId = X OR userBId = X (single-row storage, both directions)", async () => {
    const root = await load(SYMMETRIC);
    const user = root.ownChildByName("User")!;
    const desc = resolveN2mDescriptor(user, "friends", root)!;
    const { joinSpec } = buildN2mLazySpecs(desc, { id: 1 }, root);
    expect(joinSpec.where).toEqual({
      kind: "or",
      clauses: [
        { kind: "eq", column: "user_a_id", value: 1 },
        { kind: "eq", column: "user_b_id", value: 1 },
      ],
    });
  });

  test("union picks the NON-source column as the friend id (both directions)", async () => {
    const root = await load(SYMMETRIC);
    const user = root.ownChildByName("User")!;
    const desc = resolveN2mDescriptor(user, "friends", root)!;
    const { makeTargetSpec } = buildN2mLazySpecs(desc, { id: 1 }, root);
    // Row (1,2): friend is 2 (forward). Row (3,1): friend is 3 (reverse). Row (1,4): friend 4.
    const targetSpec = makeTargetSpec([
      { user_a_id: 1, user_b_id: 2 },
      { user_a_id: 3, user_b_id: 1 },
      { user_a_id: 1, user_b_id: 4 },
    ]);
    expect(targetSpec!.table).toBe("users");
    expect((targetSpec!.where as { values: unknown[] }).values.sort()).toEqual([2, 3, 4]);
  });

  test("batch: join WHERE (userAId IN ids) OR (userBId IN ids)", async () => {
    const root = await load(SYMMETRIC);
    const user = root.ownChildByName("User")!;
    const desc = resolveN2mDescriptor(user, "friends", root)!;
    const { joinSpec } = buildN2mBatchSpecs(desc, [{ id: 1 }, { id: 2 }], root);
    expect(joinSpec.where).toEqual({
      kind: "or",
      clauses: [
        { kind: "in", column: "user_a_id", values: [1, 2] },
        { kind: "in", column: "user_b_id", values: [1, 2] },
      ],
    });
  });

  // Regression: two mutually-related records queried in the SAME batch. Row
  // (1,2) makes 1↔2 friends. The fetch set must include BOTH endpoints, else
  // the eager-include grouping can attach 1→2 but drops 2→1 (target row 1 was
  // never fetched).
  test("batch: mutual friends in one batch fetch BOTH endpoints", async () => {
    const root = await load(SYMMETRIC);
    const user = root.ownChildByName("User")!;
    const desc = resolveN2mDescriptor(user, "friends", root)!;
    const { makeTargetSpec } = buildN2mBatchSpecs(desc, [{ id: 1 }, { id: 2 }], root);
    // Row (1,2): both 1 and 2 are sources — each is the other's friend.
    const targetSpec = makeTargetSpec([{ user_a_id: 1, user_b_id: 2 }]);
    expect((targetSpec!.where as { values: unknown[] }).values.sort()).toEqual([1, 2]);
  });

  // Self-loop (a,a) with a in the batch yields a once (not twice).
  test("batch: self-loop row fetches the id once", async () => {
    const root = await load(SYMMETRIC);
    const user = root.ownChildByName("User")!;
    const desc = resolveN2mDescriptor(user, "friends", root)!;
    const { makeTargetSpec } = buildN2mBatchSpecs(desc, [{ id: 5 }], root);
    const targetSpec = makeTargetSpec([{ user_a_id: 5, user_b_id: 5 }]);
    expect((targetSpec!.where as { values: unknown[] }).values).toEqual([5]);
  });
});
