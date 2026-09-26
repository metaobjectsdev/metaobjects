// Two relationships over one foreign key that disagree on its referential action.
//
// A 1:N may be declared on either side — the parent (`Author` composition `books`) or the
// FK-owning child (`Book` association `author`) — and each side's subtype implies an
// ON DELETE default (composition → cascade, association → restrict). When BOTH are
// declared and disagree, the documented precedence (ADR-0047) lets the FK-owning side
// govern, so the parent's relationship has no effect on the constraint. That is a
// defensible rule and a silent one: an adopter declared a composition, read "cascade" in
// the docs, and got ON DELETE RESTRICT and a 409 with nothing saying why.
//
// Advisory, never a gate: changing the precedence would change the DDL of every model
// that relies on it. This names each such key, the action that governs, and the two
// one-line ways to say which one the author means. Read off the SAME walk that emits the
// FK (`buildExpectedSchema`'s `onReferentialActionConflict`), so it can only ever name a
// constraint migrate actually writes. `meta verify` lists them; `meta migrate` warns.

import type { MetaData } from "@metaobjectsdev/metadata";
import {
  buildExpectedSchema,
  describeReferentialActionConflict,
  type ReferentialActionConflict,
} from "@metaobjectsdev/migrate-ts";

export interface ReferentialActionConflictFinding {
  /** The metadata file declaring the FK-owning entity ("" when the loader recorded none). */
  file: string;
  /** `<entity FQN>.<reference name>` — the FK, which is where the fix is declared. */
  construct: string;
  message: string;
}

export interface ReferentialActionConflictOptions {
  /** Skip an entity by FQN — imported (dependency) metadata is not the adopter's to fix. */
  skip?: (fqn: string) => boolean;
}

export function scanForReferentialActionConflicts(
  root: MetaData,
  opts: ReferentialActionConflictOptions = {},
): ReferentialActionConflictFinding[] {
  const conflicts: ReferentialActionConflict[] = [];
  buildExpectedSchema(root, { onReferentialActionConflict: (c) => conflicts.push(c) });

  const out: ReferentialActionConflictFinding[] = [];
  const seen = new Set<string>();
  for (const c of conflicts) {
    const fqn = c.entity.resolutionKey();
    if (opts.skip?.(fqn) === true) continue;
    const construct = `${fqn}.${c.ref.name}`;
    if (seen.has(construct)) continue;
    seen.add(construct);
    const files = "files" in c.entity.source ? c.entity.source.files : [];
    // A node a shipped library contributed is the library's design, not the adopter's.
    if (files.some((f) => f.startsWith("library:"))) continue;
    out.push({ file: files[0] ?? "", construct, message: describeReferentialActionConflict(c) });
  }
  return out;
}
