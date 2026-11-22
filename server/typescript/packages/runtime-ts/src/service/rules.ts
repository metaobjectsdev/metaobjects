// The business-rules mechanics a generated service shell calls (ADR-0066 §6, ADR-0067 §4 and §7):
// the permission point, the state check, the guarded update and its re-read, and the contexts a
// hand-written body, hook or event handler receives.
//
// The generated shell decides WHAT: which permission a point asks about, which states a move may
// start from, which condition guards it. This module is HOW, on Drizzle, in the order ADR-0066 §6
// holds every shell to:
//
//   1. load the row: 404 `not_found` when it is absent (`loadForWrite`, ./index.ts);
//   2. the permission point: 403 `forbidden` when the policy refuses (`checkPermission`);
//   3. the row's state is in the `@from` of a move the operation may make: 409 `invalid_transition`
//      (`checkState`);
//   4. the hand-written body, when the operation has one (generated);
//   5. the guarded update, re-read once when it matches no row: 409 `invalid_transition` or
//      `transition_condition_failed`, or 404 when the row is gone (`makeTransition`);
//   6. all of it, and the event hook, in one transaction (`inWriteTransaction`).
//
// And a lifecycle field on the generic write path is the shell's to move: 409 `state_managed`
// (`checkStateManaged`).

import {
  BUSINESS_ERROR_CODE_PATTERN,
  EXPR_FN_COALESCE,
  EXPR_OP_IS_NOT_NULL,
  EXPR_OP_NOT,
  FILTER_COMPOSE_AND,
  FILTER_COMPOSE_OR,
  FILTER_OP_EQ,
  FILTER_OP_GT,
  FILTER_OP_GTE,
  FILTER_OP_IS_NULL,
  FILTER_OP_LT,
  FILTER_OP_LTE,
  FILTER_OP_NE,
  RESERVED_ERROR_CODES,
  type ExprNode,
} from "@metaobjectsdev/metadata";
import { and, eq, gt, gte, inArray, isNotNull, isNull, lt, lte, ne, not, or, sql, type SQL } from "drizzle-orm";
import { supportsReturning, type SqlDialect } from "../sql-dialect.js";
import { extractRowCount } from "../drizzle-fastify/util.js";
// Called at run time only, so the cycle with ./index.ts (which re-exports this module) is harmless.
import { notFound, readOne, refuse, REFUSAL_STATUS, type ServiceErrorBody } from "./index.js";

// biome-ignore lint/suspicious/noExplicitAny: the adopter's Drizzle database, table or transaction
type Drizzle = any;

/** The wire code of a policy refusal (ADR-0066 §6 step 2). */
export const FORBIDDEN = "forbidden";
/** The row's state is not one a move the operation may make starts from (§6 steps 3 and 5). */
export const INVALID_TRANSITION = "invalid_transition";
/** The state allows the move and its `@condition` does not hold (§6 step 5). */
export const TRANSITION_CONDITION_FAILED = "transition_condition_failed";
/** A lifecycle field written through the generic create or update path (§6 step 7). */
export const STATE_MANAGED = "state_managed";

const RESERVED: ReadonlySet<string> = new Set(RESERVED_ERROR_CODES);

/**
 * Refuse with a business code a body, hook or event handler chose: answered 409 with the code and
 * the details, and the transaction rolls back. A code the shell or the API contract answers itself
 * (ADR-0066 O5), or one that is not lower snake case, is a programming error, thrown as such, so a
 * client never reads a business refusal as the shell's own.
 */
export function refuseBusiness(code: string, details: Readonly<Record<string, unknown>> = {}): never {
  if (RESERVED.has(code) || !BUSINESS_ERROR_CODE_PATTERN.test(code)) {
    throw new Error(`refuse("${code}"): a business refusal takes a lower snake case code the shell and the API contract do not answer themselves`);
  }
  refuse({ ...details, error: code } as ServiceErrorBody, REFUSAL_STATUS);
}

/** What a hand-written hook or event handler receives beside its own arguments. */
export interface HookContext<A, Tx> {
  /** The transaction the write runs in. What the handler writes on it commits or rolls back with it. */
  readonly tx: Tx;
  /** The actor the operation was called for, passed through untouched (ADR-0067 §7). */
  readonly actor: A | undefined;
  /** Refuse the operation with a business code: 409, and everything rolls back. */
  refuse(code: string, details?: Readonly<Record<string, unknown>>): never;
}

/** What a hand-written operation body receives (ADR-0066 §6 step 4). `E` is the operation's `@errors`. */
export interface BodyContext<A, Tx, E extends string> {
  /** The transaction of a command, or the read scope of a query. */
  readonly tx: Tx;
  readonly actor: A | undefined;
  /** Refuse with one of the operation's declared errors: 409, and everything rolls back. */
  refuse(code: E, details?: Readonly<Record<string, unknown>>): never;
}

/** The context of a hook, a body or an event handler running on `tx` for `actor`. */
export function handlerContext<A, Tx>(tx: Tx, actor: A | undefined): HookContext<A, Tx> & BodyContext<A, Tx, string> {
  return { tx, actor, refuse: refuseBusiness };
}

/** One write the package's event hook is told about, inside the write's transaction (ADR-0066 §7). */
export type WriteEvent<A> =
  | { readonly kind: "create"; readonly entity: string; readonly key: unknown; readonly row: unknown; readonly actor: A | undefined; readonly at: Date }
  | {
      readonly kind: "update";
      readonly entity: string;
      readonly key: unknown;
      readonly row: unknown;
      readonly previous: unknown;
      readonly actor: A | undefined;
      readonly at: Date;
    }
  | { readonly kind: "delete"; readonly entity: string; readonly key: unknown; readonly row: unknown; readonly actor: A | undefined; readonly at: Date }
  | {
      readonly kind: "transition";
      readonly entity: string;
      readonly key: unknown;
      /** The lifecycle's field. */
      readonly lifecycle: string;
      readonly transition: string;
      readonly from: string;
      readonly to: string;
      /** The command that made it: the transition's own derived command, or a declared one. */
      readonly operation: string;
      readonly actor: A | undefined;
      readonly at: Date;
    }
  | {
      readonly kind: "command";
      /** A declared command whose body made no move. */
      readonly operation: string;
      readonly entity: string | undefined;
      readonly key: unknown;
      readonly actor: A | undefined;
      readonly at: Date;
    };

/** The package's write-event hook: an outbox, a history table or an audit log is written here. */
export interface WriteEvents<A, Tx> {
  onWrite(event: WriteEvent<A>, ctx: HookContext<A, Tx>): void | Promise<void>;
}

/** Tell `events` (when the app supplied any) about `event`, on the write's transaction. */
export async function emitWrite<A, Tx>(events: WriteEvents<A, Tx> | undefined, event: WriteEvent<A>, tx: Tx): Promise<void> {
  if (events !== undefined) await events.onWrite(event, handlerContext(tx, event.actor));
}

/** A policy: whether `actor` may pass the permission point named `permission` (ADR-0066 §1). */
export interface Policy<P extends string, A, Tx> {
  allows(permission: P, actor: A | undefined, row: unknown, input: unknown, tx: Tx): boolean | Promise<boolean>;
}

/** The permission point (ADR-0066 §6 step 2): 403 `forbidden` unless the policy allows it. */
export async function checkPermission<P extends string, A, Tx>(
  policy: Policy<P, A, Tx>,
  permission: P,
  actor: A | undefined,
  row: unknown,
  input: unknown,
  tx: Tx,
): Promise<void> {
  if (!(await policy.allows(permission, actor, row, input, tx))) refuse({ error: FORBIDDEN }, 403);
}

/** A move a lifecycle may make: its field, the states it starts from and the state it ends in. */
export interface TransitionSpec {
  readonly name: string;
  /** The lifecycle's field, as the Drizzle table names its column. */
  readonly field: string;
  readonly from: readonly string[];
  readonly to: string;
  /** The `@condition`, an attr.expression CHECK-subset node over the entity's fields. */
  readonly condition?: ExprNode | undefined;
}

/** Whether `row` is in a state `t` starts from. */
export function inFromState(row: Readonly<Record<string, unknown>>, t: TransitionSpec): boolean {
  return t.from.includes(String(row[t.field]));
}

/** The state check (ADR-0066 §6 step 3): 409 `invalid_transition` unless one of `moves` starts from the row's state. */
export function checkState(row: Readonly<Record<string, unknown>>, moves: readonly TransitionSpec[]): void {
  if (!moves.some((t) => inFromState(row, t))) refuse({ error: INVALID_TRANSITION }, REFUSAL_STATUS);
}

/**
 * The guarded update (ADR-0066 §6 step 5), one statement:
 * `UPDATE ... SET <state> = :to WHERE <key> AND <state> IN (:from) [AND <condition>]`.
 * Answers the row as written. When it matches no row the row is read once more: gone is 404,
 * another state is 409 `invalid_transition`, and the state it starts from with a condition that
 * does not hold is 409 `transition_condition_failed`.
 */
export async function makeTransition(
  tx: Drizzle,
  table: Drizzle,
  key: SQL,
  t: TransitionSpec,
  dialect: SqlDialect,
): Promise<Record<string, unknown>> {
  const guards: SQL[] = [key, inArray(table[t.field], [...t.from])];
  if (t.condition !== undefined) guards.push(conditionSql(table, t.condition));
  const where = and(...guards)!;
  const set = { [t.field]: t.to };
  let written: Record<string, unknown> | undefined;
  if (supportsReturning(dialect)) {
    written = ((await tx.update(table).set(set).where(where).returning()) as Record<string, unknown>[])[0];
  } else if (extractRowCount(await tx.update(table).set(set).where(where)) > 0) {
    // MySQL: no RETURNING. mysql2 reports matched rows (FOUND_ROWS), so a self-transition counts.
    written = await readOne(tx, table, key);
  }
  if (written !== undefined) return written;
  const now = await readOne(tx, table, key);
  if (now === undefined) notFound();
  refuse({ error: inFromState(now, t) ? TRANSITION_CONDITION_FAILED : INVALID_TRANSITION }, REFUSAL_STATUS);
}

/**
 * The generic write path may not move a lifecycle (ADR-0066 §6 step 7): a lifecycle field in
 * `values` that differs from `current` is refused 409 `state_managed`, and one equal to it (a
 * client echoing the read model) is dropped. On a create `current` holds the initial states when
 * `rules.lifecycle.create` is `initial` (the default); under `any` the generator passes none.
 */
export function checkStateManaged(values: Record<string, unknown>, current: Readonly<Record<string, unknown>>, fields: readonly string[]): void {
  for (const f of fields) {
    if (!(f in values) || values[f] === undefined) continue;
    if (String(values[f]) !== String(current[f])) refuse({ error: STATE_MANAGED }, REFUSAL_STATUS);
    delete values[f];
  }
}

/**
 * A create starts each lifecycle in its initial state under `rules.lifecycle.create: initial`
 * (the default, ADR-0066 §5): a state the input names is refused 409 `state_managed` unless it is
 * the initial one, and an omitted one is the initial one. Under `any` the generator skips this.
 */
export function checkCreateState(values: Record<string, unknown>, initials: Readonly<Record<string, string>>): void {
  for (const [f, initial] of Object.entries(initials)) {
    if (values[f] === undefined || values[f] === null) values[f] = initial;
    else if (String(values[f]) !== initial) refuse({ error: STATE_MANAGED }, REFUSAL_STATUS);
  }
}

type Node = Record<string, unknown>;
type Operand = SQL | Drizzle;

/**
 * `node`, a `@condition` (attr.expression's CHECK subset: fields, literals, the six comparisons,
 * the null tests, and / or / not, coalesce), as a Drizzle condition over `table`'s columns. A
 * literal compared with a field is bound through that field's column, so it is written in the form
 * the column stores (an int-backed enum's member is its integer). A node outside the subset is
 * refused, never dropped: a guard that loses its condition makes a move the model forbids.
 */
export function conditionSql(table: Drizzle, node: ExprNode): SQL {
  const n = node as Node;
  const op = n["op"];
  if (typeof op === "string" && COMPARE.has(op)) {
    const left = operand(table, n["left"], partnerColumn(table, n["right"]));
    const right = operand(table, n["right"], partnerColumn(table, n["left"]));
    return COMPARE.get(op)!(left, right);
  }
  if (op === FILTER_OP_IS_NULL) return isNull(operand(table, n["arg"], undefined));
  if (op === EXPR_OP_IS_NOT_NULL) return isNotNull(operand(table, n["arg"], undefined));
  if (op === EXPR_OP_NOT) return not(conditionSql(table, n["arg"] as ExprNode));
  if (op === FILTER_COMPOSE_AND || op === FILTER_COMPOSE_OR) {
    const parts = (n["args"] as ExprNode[]).map((a) => conditionSql(table, a));
    return (op === FILTER_COMPOSE_AND ? and(...parts) : or(...parts))!;
  }
  throw new Error(`@condition: ${JSON.stringify(node)} is not a condition the guarded update can apply`);
}

const COMPARE = new Map<string, (l: Operand, r: Operand) => SQL>([
  [FILTER_OP_EQ, (l, r) => eq(l, r)],
  [FILTER_OP_NE, (l, r) => ne(l, r)],
  [FILTER_OP_GT, (l, r) => gt(l, r)],
  [FILTER_OP_GTE, (l, r) => gte(l, r)],
  [FILTER_OP_LT, (l, r) => lt(l, r)],
  [FILTER_OP_LTE, (l, r) => lte(l, r)],
]);

function column(table: Drizzle, field: string): Drizzle {
  const c = table[field];
  if (c === undefined) throw new Error(`@condition names "${field}", which is not a column of the table`);
  return c;
}

/** The column a literal compared with `node` is bound through: `node`'s field, or a coalesce's first. */
function partnerColumn(table: Drizzle, node: unknown): Drizzle | undefined {
  const n = (node ?? {}) as Node;
  if (typeof n["field"] === "string") return column(table, n["field"]);
  if (n["fn"] === EXPR_FN_COALESCE && Array.isArray(n["args"])) {
    for (const a of n["args"] as unknown[]) {
      const c = partnerColumn(table, a);
      if (c !== undefined) return c;
    }
  }
  return undefined;
}

function operand(table: Drizzle, x: unknown, partner: Drizzle | undefined): Operand {
  const n = (x ?? {}) as Node;
  if (typeof n["field"] === "string") return column(table, n["field"]);
  if ("value" in n) {
    const v = n["value"];
    return v === null ? sql`null` : partner === undefined ? sql.param(v) : sql.param(v, partner);
  }
  if (n["fn"] === EXPR_FN_COALESCE && Array.isArray(n["args"])) {
    // The arguments of a coalesce share its type, so a literal among them takes the first field's form.
    const own = partnerColumn(table, n) ?? partner;
    const args = (n["args"] as unknown[]).map((a) => operand(table, a, own));
    return sql`coalesce(${sql.join(args, sql`, `)})`;
  }
  throw new Error(`@condition: ${JSON.stringify(x)} is not an operand the guarded update can apply`);
}
