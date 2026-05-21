// CREATE TABLE SQL for test fixtures. Hand-written until SP4 (migrate-ts) ships.
// Per fixture, exports SQLite + Postgres variants of the schema.

export const SINGLE_ENTITY_SQLITE = `
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  body TEXT
);
`;

export const SINGLE_ENTITY_POSTGRES = `
CREATE TABLE posts (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  body TEXT
);
`;

export const TWO_ENTITIES_FK_SQLITE = `
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE
);
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  author_id INTEGER NOT NULL REFERENCES users(id)
);
`;

export const TWO_ENTITIES_FK_POSTGRES = `
CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE
);
CREATE TABLE posts (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  author_id BIGINT NOT NULL REFERENCES users(id)
);
`;

export const N2M_SHAPE_SQLITE = `
CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL
);
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL
);
CREATE TABLE post_tags (
  post_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);
`;

export const N2M_SHAPE_POSTGRES = `
CREATE TABLE posts (
  id BIGSERIAL PRIMARY KEY,
  title TEXT NOT NULL
);
CREATE TABLE tags (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL
);
CREATE TABLE post_tags (
  post_id BIGINT NOT NULL,
  tag_id BIGINT NOT NULL,
  PRIMARY KEY (post_id, tag_id)
);
`;

/** Split a multi-statement script into individual statements (libsql/Kysely raw needs one at a time). */
export function splitStatements(sql: string): string[] {
  return sql.split(";").map((s) => s.trim()).filter(Boolean);
}
