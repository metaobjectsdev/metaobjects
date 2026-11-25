# Wrangler's configuration schema, vendored for the tests

`config-schema.json` is the JSON Schema the `wrangler` npm package ships as
`config-schema.json`, from **wrangler 4.168.0** (the version the generated scripts pin,
`WRANGLER_VERSION` in `src/constants.ts`). Its `description`, `markdownDescription` and
`examples` keys are removed to keep it small; nothing else is changed.

Wrangler is licensed MIT OR Apache-2.0 (Cloudflare, Inc.). The tests validate every
generated `wrangler.jsonc` against it, so a key the generator writes that Wrangler does not
accept fails the build here, not on a deploy.

To move to a newer Wrangler: bump `WRANGLER_VERSION`, replace this file from that version's
package with the same three keys removed, and run the tests.
