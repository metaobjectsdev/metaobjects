// rc.21 part B fix round 2 (N2): `origin.function` declares its signature (`@params`, `@returns`)
// and the view casts the call to the carrying field's column type. The declaration is trusted at
// load and codegen, so a wrong one would be hidden by that cast (a `numeric` result declared `int`
// rounds). `meta verify --db` reads each declared function from `pg_proc` and refuses any whose
// parameter or return types are not the declared ones.

import type { Kysely } from "kysely";
import { sql } from "kysely";
import {
  isMetaObject,
  TYPE_OBJECT,
  TYPE_ORIGIN,
  ORIGIN_SUBTYPE_FUNCTION,
  ORIGIN_FUNCTION_ATTR_FUNCTION,
  ORIGIN_FUNCTION_ATTR_SCHEMA,
  ORIGIN_FUNCTION_ATTR_ARGS,
  ORIGIN_FUNCTION_ATTR_PARAMS,
  ORIGIN_FUNCTION_ATTR_RETURNS,
  type MetaData,
} from "@metaobjectsdev/metadata";
import { fieldSqlType } from "../expected-schema.js";
import type { SqlType } from "../sql-type.js";

/** One declared function call, with the database type names each position accepts. */
interface DeclaredFunction {
  readonly where: string;
  readonly schema: string;
  readonly name: string;
  readonly declared: string;
  readonly params: readonly (readonly string[])[];
  readonly returns: readonly string[];
}

/** One overload as `pg_proc` has it, its types spelled by `format_type(oid, NULL)`. */
interface PgFunction {
  readonly args: readonly string[];
  readonly returns: string;
  readonly retset: boolean;
}

const TEXT_TYPES = ["text", "character varying", "character"] as const;

/** The `format_type` names (no modifier) a column of this type has. Empty: not checkable. */
function pgTypeNames(t: SqlType): readonly string[] {
  switch (t.kind) {
    case "text": return TEXT_TYPES;
    case "integer": return [t.bits === 64 ? "bigint" : "integer"];
    case "real": return ["double precision"];
    case "real4": return ["real"];
    case "numeric": return ["numeric"];
    case "boolean": return ["boolean"];
    case "date": return ["date"];
    case "uuid": return ["uuid"];
    case "timestamp": return [t.withTimezone ? "timestamp with time zone" : "timestamp without time zone"];
    default: return [];
  }
}

/** A declared parameter subtype's names, when the argument's field cannot be read. */
function subtypeTypeNames(subType: string): readonly string[] {
  switch (subType) {
    case "string": return TEXT_TYPES;
    case "int": return ["integer"];
    case "long": return ["bigint"];
    case "double": return ["double precision"];
    case "float": return ["real"];
    case "decimal": return ["numeric"];
    case "boolean": return ["boolean"];
    case "date": return ["date"];
    case "uuid": return ["uuid"];
    case "timestamp": return ["timestamp with time zone", "timestamp without time zone"];
    default: return [];
  }
}

function asList(raw: unknown): string[] {
  if (raw === undefined) return [];
  return (Array.isArray(raw) ? raw : [raw]).filter((v): v is string => typeof v === "string");
}

/** Every `origin.function` the model declares, once each. */
export function declaredFunctions(root: MetaData): DeclaredFunction[] {
  const out: DeclaredFunction[] = [];
  const seen = new Set<MetaData>();
  // ADR-0039: effective children — resolve rather than rely on root being unextended.
  for (const obj of root.children()) {
    if (obj.type !== TYPE_OBJECT || !isMetaObject(obj)) continue;
    for (const field of obj.fields()) {
      // ADR-0039: own — origin.* never inherits (ADR-0029); an inherited field is visited
      // through the object that declares it, and `seen` keeps each origin once.
      for (const origin of field.ownChildren()) {
        if (origin.type !== TYPE_ORIGIN || origin.subType !== ORIGIN_SUBTYPE_FUNCTION || seen.has(origin)) continue;
        seen.add(origin);
        const name = origin.ownAttr(ORIGIN_FUNCTION_ATTR_FUNCTION);
        if (typeof name !== "string") continue;
        const schemaAttr = origin.ownAttr(ORIGIN_FUNCTION_ATTR_SCHEMA);
        const schema = typeof schemaAttr === "string" ? schemaAttr : "public";
        const args = asList(origin.ownAttr(ORIGIN_FUNCTION_ATTR_ARGS));
        const params = asList(origin.ownAttr(ORIGIN_FUNCTION_ATTR_PARAMS));
        const returns = origin.ownAttr(ORIGIN_FUNCTION_ATTR_RETURNS);
        const fields = obj.fields();
        out.push({
          where: `${obj.name}.${field.name}`,
          schema,
          name,
          declared: `(${params.join(", ")}) → ${String(returns)}`,
          params: params.map((p, i) => {
            // The argument's own column type when it is a field of this object (a local or a
            // zoned timestamp, say); the declared subtype's otherwise.
            const argField = fields.find((f) => f.name === args[i]);
            const names = argField !== undefined && argField.subType === p ? pgTypeNames(fieldSqlType(argField)) : [];
            return names.length > 0 ? names : subtypeTypeNames(p);
          }),
          returns: pgTypeNames(fieldSqlType(field)),
        });
      }
    }
  }
  return out;
}

async function overloads(db: Kysely<any>, schema: string, name: string): Promise<PgFunction[]> {
  const result = await sql<{ args: string[]; returns: string; retset: boolean }>`
    SELECT ARRAY(SELECT format_type(a.t, NULL) FROM unnest(p.proargtypes::oid[]) WITH ORDINALITY AS a(t, i) ORDER BY a.i) AS args,
           format_type(p.prorettype, NULL) AS returns, p.proretset AS retset
      FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = ${schema} AND p.proname = ${name} AND p.prokind = 'f'`.execute(db);
  return result.rows.map((r) => ({ args: r.args, returns: r.returns, retset: r.retset }));
}

function matches(declared: DeclaredFunction, fn: PgFunction): boolean {
  if (fn.retset || fn.args.length !== declared.params.length) return false;
  if (declared.returns.length > 0 && !declared.returns.includes(fn.returns)) return false;
  return declared.params.every((accepted, i) => accepted.length === 0 || accepted.includes(fn.args[i]!));
}

/**
 * The findings for every declared `origin.function` the Postgres database does not have with
 * the declared parameter and return types: one line each, empty when all match.
 */
export async function checkDeclaredFunctions(db: Kysely<any>, root: MetaData): Promise<string[]> {
  const findings: string[] = [];
  for (const declared of declaredFunctions(root)) {
    const found = await overloads(db, declared.schema, declared.name);
    if (found.some((fn) => matches(declared, fn))) continue;
    const qualified = `${declared.schema}.${declared.name}`;
    const expected = `(${declared.params.map((p) => p.join(" | ") || "any").join(", ")}) → ${declared.returns.join(" | ") || "any"}`;
    findings.push(found.length === 0
      ? `origin.function ${qualified} on ${declared.where}: no such function in the database (declared ${declared.declared}).`
      : `origin.function ${qualified} on ${declared.where}: declared ${declared.declared}, which needs ${qualified}${expected}; ` +
        `the database has ${found.map((fn) => `${qualified}(${fn.args.join(", ")}) → ${fn.retset ? "SETOF " : ""}${fn.returns}`).join("; ")}.`);
  }
  return findings;
}
