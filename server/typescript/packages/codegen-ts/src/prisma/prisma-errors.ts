// The prisma-schema generator's own errors. They are generator errors, printed in the message;
// they are not loader codes and are not listed in fixtures/conformance/ERROR-CODES.json.

/** The provider is not one the generator writes a schema for (postgresql, mysql, sqlite). */
export const ERR_PRISMA_UNSUPPORTED_PROVIDER = "ERR_PRISMA_UNSUPPORTED_PROVIDER";
/** A read-only source (a view, stored procedure or table function) that Prisma cannot create. */
export const ERR_PRISMA_READ_ONLY_SOURCE = "ERR_PRISMA_READ_ONLY_SOURCE";
/** An index Prisma cannot declare: an expression index or a partial index. */
export const ERR_PRISMA_UNSUPPORTED_INDEX = "ERR_PRISMA_UNSUPPORTED_INDEX";
/** A CHECK constraint on SQLite, which cannot add one to a table Prisma created. */
export const ERR_PRISMA_UNSUPPORTED_CHECK = "ERR_PRISMA_UNSUPPORTED_CHECK";
/** A table with no primary key: Prisma requires every model to have one. */
export const ERR_PRISMA_NO_PRIMARY_KEY = "ERR_PRISMA_NO_PRIMARY_KEY";
/** A foreign key Prisma cannot model as a relation. */
export const ERR_PRISMA_UNMAPPABLE_RELATION = "ERR_PRISMA_UNMAPPABLE_RELATION";
/** Two models, or two fields of one model, that would share a Prisma name. */
export const ERR_PRISMA_NAME_COLLISION = "ERR_PRISMA_NAME_COLLISION";

export const PRISMA_ERROR_CODES = [
  ERR_PRISMA_UNSUPPORTED_PROVIDER,
  ERR_PRISMA_READ_ONLY_SOURCE,
  ERR_PRISMA_UNSUPPORTED_INDEX,
  ERR_PRISMA_UNSUPPORTED_CHECK,
  ERR_PRISMA_NO_PRIMARY_KEY,
  ERR_PRISMA_UNMAPPABLE_RELATION,
  ERR_PRISMA_NAME_COLLISION,
] as const;
export type PrismaErrorCode = (typeof PRISMA_ERROR_CODES)[number];

/**
 * Something the Prisma schema cannot express. The generator refuses rather than write a schema
 * that would push a database the model does not describe. `message` is `"<CODE>: <detail>"`;
 * the detail names the node, says why Prisma cannot take it, and says what to change.
 */
export class PrismaSchemaError extends Error {
  readonly code: PrismaErrorCode;

  constructor(code: PrismaErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "PrismaSchemaError";
    this.code = code;
  }
}
