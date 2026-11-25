# Changelog: cloudflare pack

This pack's own changelog (ADR-0069). The root `CHANGELOG.md` records core only.

## [0.1.0] - unreleased

- **First version.** `deployment.worker` (a Worker, with or without static assets) and
  `deployment.pages` (a Pages site) on the delivery pack's `deployment.base`, held to its
  references, and the Worker's bindings `cloudflare.d1`, `.kv`, `.r2`, `.queue` and
  `.ratelimit`. An abstract deployment holds what every environment shares; each environment's
  deployment `extends` it and holds only its differences.
- **Generators**: `wrangler.jsonc` (the top-level environment plus one complete `env` block per
  other environment, each fact commented with the model node it comes from, valid against
  Wrangler 4.168.0's schema), `deploy/cloudflare/wrangler.sh` (wrangler as the deployment's
  narrow API token from the vault, the global-key variables unset, a pinned wrangler),
  `deploy.sh`, `sync-secrets.sh` (vault to Cloudflare through `keys-axi`, `wrangler secret put`
  from stdin), `doctor.sh` and `unexpressed.md`.
- Fixtures `cloudflare-worker-environments`, `cloudflare-worker-cron-ratelimits`,
  `cloudflare-pages-site` and `cloudflare-pages-secrets` with golden output, five load-error
  fixtures, a coverage test that holds the output to every fact of the hand-written configurations
  the fixtures are modelled on, and tests that run the generated scripts against stubbed
  `keys-axi` and `npx`. TypeScript port.
