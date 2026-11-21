import { FkTargetNotUniqueError, type FkTargetViolation } from "@metaobjectsdev/migrate-ts";
import { log } from "./log.js";

/**
 * FKs whose target is not a unique key, on a SQLite database that does not enforce the target's
 * uniqueness when the table is created: reported, not refused. `prefix` is the command name that
 * leads each line (`migrate`, `verify`).
 */
export function warnUnenforcedFkTargets(
  prefix: string,
  violations: readonly FkTargetViolation[] | undefined,
  allowedBySetting = false,
): void {
  if (violations === undefined || violations.length === 0) return;
  log.warn(`${prefix}: ${new FkTargetNotUniqueError([...violations]).message}`);
  log.warn(allowedBySetting
    ? `${prefix}: migrate.foreignKeyTargets is "warn", so nothing is refused. The database decides: Postgres refuses the foreign key when it is applied unless a unique index it holds already covers the target, and a SQLite write with PRAGMA foreign_keys on fails with "foreign key mismatch". Declare the unique key on the target to make this go away.`
    : `${prefix}: SQLite creates the table anyway and checks foreign keys only with PRAGMA foreign_keys on, so nothing is refused; a write with it on fails with "foreign key mismatch".`);
}
