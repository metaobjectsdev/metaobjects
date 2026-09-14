// FR-043 §3.4 — `meta eject --list` staleness across a MULTI-PACKAGE library.
//
// The staleness comparison keys root-level nodes by NAME rather than by resolution key,
// because §3.4 invites an adopter who ejects to "rename the package freely" — keying on
// the FQN would report every node of a renamed copy as both upstream-only and local-only.
//
// The bare name alone is not enough to be a key. A library that ships two root-level
// nodes with the SAME bare name in DIFFERENT packages collapses both onto one entry, and
// whichever is serialized last silently wins — so a real divergence in the OTHER one is
// reported as "identical", which is the worst answer a staleness check can give. Today's
// shipped libraries each use a single package, so nothing exercises it; these tests do,
// so the second-package library cannot land the misreport with it.
//
// The key is therefore the node's package PATH RELATIVE to the library's own root
// package, which survives the one edit §3.4 invites: renaming `metaobjects::iam` to
// `acme::identity` moves the root and leaves the `admin` suffix exactly where it was.
import { describe, test, expect } from "bun:test";
import { MetaDataLoader, InMemoryStringSource, type MetaData } from "@metaobjectsdev/metadata";
import { ownNodesByName } from "../src/lib/library-eject.js";

interface Extra {
  /** An added field on the root-package `User`. */
  base?: string;
  /** An added field on the `admin`-package `User`. */
  admin?: string;
}

function object(pkg: string, field: string, extra?: string): InMemoryStringSource {
  return new InMemoryStringSource(
    `metadata:\n  package: ${pkg}\n  children:\n` +
      `    - object.value:\n        name: User\n        children:\n` +
      `          - field.string: { name: ${field} }\n` +
      (extra === undefined ? "" : `          - field.string: { name: ${extra} }\n`),
    { id: `library:${pkg}.yaml`, format: "yaml" },
  );
}

/** One root-level node per package, so the two share a bare name and nothing else. */
async function load(root: string, extra: Extra = {}): Promise<MetaData> {
  const result = await new MetaDataLoader({ strict: true }).load([
    object(root, "email", extra.base),
    object(`${root}::admin`, "scope", extra.admin),
  ]);
  expect(result.errors).toEqual([]);
  return result.root;
}

/** What `libraryStaleness` does with the two maps, in the same three counters. */
function compare(up: Map<string, string>, mine: Map<string, string>) {
  let changed = 0, upstreamOnly = 0, localOnly = 0;
  for (const [key, text] of up) {
    if (!mine.has(key)) upstreamOnly++;
    else if (mine.get(key) !== text) changed++;
  }
  for (const key of mine.keys()) if (!up.has(key)) localOnly++;
  return { changed, upstreamOnly, localOnly };
}

describe("eject staleness across a multi-package library", () => {
  test("two same-named nodes in different packages stay DISTINCT", async () => {
    const keys = [...ownNodesByName(await load("metaobjects::iam")).keys()].sort();
    // Not one entry. `admin::User` is a different declaration from `User` and the
    // comparison has to be able to say so.
    expect(keys).toEqual(["User", "admin::User"]);
  });

  test("a renamed package still compares as identical — §3.4's invited edit", async () => {
    const up = ownNodesByName(await load("metaobjects::iam"));
    const mine = ownNodesByName(await load("acme::identity"));
    expect(compare(up, mine)).toEqual({ changed: 0, upstreamOnly: 0, localOnly: 0 });
  });

  test("an edit to the ROOT-package node is reported, not swallowed by its namesake", async () => {
    const up = ownNodesByName(await load("metaobjects::iam"));
    const mine = ownNodesByName(await load("acme::identity", { base: "nickname" }));
    // Keyed by bare name, the `admin` copy overwrites this one on BOTH sides and the
    // edit reads as `identical` — a staleness check answering the one question it
    // exists to answer with the wrong answer.
    expect(compare(up, mine)).toEqual({ changed: 1, upstreamOnly: 0, localOnly: 0 });
  });

  test("an edit to the DEEPER package is reported too", async () => {
    const up = ownNodesByName(await load("metaobjects::iam"));
    const mine = ownNodesByName(await load("acme::identity", { admin: "grantedBy" }));
    expect(compare(up, mine)).toEqual({ changed: 1, upstreamOnly: 0, localOnly: 0 });
  });

  test("an edit to BOTH is reported as two", async () => {
    const up = ownNodesByName(await load("metaobjects::iam"));
    const mine = ownNodesByName(
      await load("acme::identity", { base: "nickname", admin: "grantedBy" }),
    );
    expect(compare(up, mine)).toEqual({ changed: 2, upstreamOnly: 0, localOnly: 0 });
  });
});
