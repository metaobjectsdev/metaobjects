import { MigrationApplyError } from "@metaobjectsdev/migrate-ts";

/**
 * What to tell someone whose committed chain will not apply to an empty database.
 *
 * The message this replaces prescribed ONE fix — *"fix this with a NEW migration that
 * creates the missing object"* — and it cannot work, in any case. Migrations apply in
 * timestamp order, so anything authored now sorts AFTER the migration that failed; the
 * object is still missing when that file runs. Two estates found it from opposite
 * directions and it is the same defect both times:
 *
 * - a chain whose FIRST migration needs a schema an out-of-band script creates (the third
 *   migration emits `CREATE SCHEMA IF NOT EXISTS`, the first predates it). A new migration
 *   sorts last, after the one that needs the schema.
 * - a project where **another tool owns schema creation** — drizzle-kit's chain builds the
 *   tables, `.metaobjects/migrations/` holds later incremental patches. Following the
 *   printed remedy literally means hand-authoring every `CREATE TABLE` into the MetaObjects
 *   chain, i.e. duplicating a schema this project does not own, which is the opposite of
 *   what the agent context teaches two paragraphs into its own Principles.
 *
 * The old message assumed MetaObjects is the only schema authority and offered no third
 * possibility. These name the fixes that exist, and the head-of-chain case gets the extra
 * sentence that is only true there: nothing in this chain could have created what the
 * first migration needs, so the base schema comes from outside it.
 *
 * "Applied migrations are immutable" is kept, because it is true and it is the reason the
 * obvious fix is not offered first — but it is stated as the CONDITION it actually is
 * (a checksum guard on databases that already ran the file), not as a blanket ban, because
 * a migration no database has applied yet is edited in place every day.
 */
/**
 * Is this the migrate engine's own apply failure?
 *
 * By NAME, not `instanceof`. Two physical copies of `@metaobjectsdev/migrate-ts` in one
 * process — a globally-installed or linked `meta` alongside a project-local dependency —
 * give the class object and the instance different identities, so `instanceof` returns
 * false for a real error and the remedy silently degrades to its un-positioned form. That
 * is the same class-identity defect that split ts-poet's `Code` in 0.21.6 and drove the
 * exported node guards in `metadata`. Unreachable through today's single import; costs one
 * line to make unreachable by construction.
 */
function isApplyError(err: unknown): err is MigrationApplyError {
  return err instanceof MigrationApplyError
    || (err instanceof Error && err.name === "MigrationApplyError"
        && typeof (err as MigrationApplyError).migration === "string"
        && typeof (err as MigrationApplyError).index === "number");
}

export function replayRemedy(err: unknown): string[] {
  const applyErr = isApplyError(err) ? err : undefined;
  const head = applyErr !== undefined && applyErr.index === 0;
  const which =
    applyErr === undefined
      ? "the committed chain does not apply to an empty database."
      : `'${applyErr.migration}' (migration ${applyErr.index + 1} of ${applyErr.pendingCount}) ` +
        `does not apply to an empty database.`;

  const out = [which];
  if (head) {
    out.push(
      "It is the FIRST migration in the chain, so nothing here could have created what it " +
        "needs — this chain has never built a database from empty, and its base schema comes " +
        "from outside it.",
    );
  }
  out.push(
    "A NEW migration cannot fix this: migrations apply in timestamp order, so anything you " +
      "author now sorts after the file that failed.",
  );
  out.push(
    "The fixes that do work: if another tool or an out-of-band script owns schema creation " +
      "for this project, --replay asserts a property this chain does not have — don't wire " +
      "it. Otherwise correct the migration in place if no database has applied it yet " +
      "(the ledger's checksum guard is what stops you once one has), or re-baseline from a " +
      "live database with `meta migrate baseline --from-db --db <url>`.",
  );
  return out;
}
