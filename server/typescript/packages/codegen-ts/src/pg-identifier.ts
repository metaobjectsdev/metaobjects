// rc.21 part B (N2): Postgres's 63-byte identifier fit, re-exported where the generators (and the
// owned template copies, which import only from `@metaobjectsdev/codegen-ts/engine`) can reach it.
export { fitPgIdentifier } from "@metaobjectsdev/migrate-ts/expected";
