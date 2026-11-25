- **`meta migrate` is the reference migration helper, one option, in the docs and the agent
  files.** Each port page now leads with its native migration path (EF Core Migrations, Flyway or
  Liquibase, Exposed, Alembic, sqlx), handed the schema `meta schema` prints. The always-on
  `.metaobjects/AGENTS.md` carries the `meta migrate` steps, the `verify --db` step and the
  `.metaobjects/migrations/` commit line only when the project chose a migrate dialect
  (`migrate.dialect` in `.metaobjects/config.json`, which `meta init --dialect` writes); `meta init`
  prints its migrate step on the same condition. The generated `agent/schema.md` says to change the
  schema with `meta migrate` on the same condition, and otherwise with the project's own migration
  tool. The shared page data gains `hasMigrate`, and the shipped agent tree (manifest schema `2`)
  ships every stack with and without the steps, the second with a `-migrate` id suffix.
