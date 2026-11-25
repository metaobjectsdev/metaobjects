# Changelog: railway pack

This pack's own changelog (ADR-0069). The root `CHANGELOG.md` records core only.

## [0.1.0] - unreleased

- **First version.** `deployment.railway` (`@project`, `@service`) on the delivery pack's
  `deployment.base`, held to its references. The worked example (an app's model plus an estate
  repository's additions and overlay) is the `railway-worked-example` fixture. TypeScript port.
- `@repo`, `@image` and `@checkSuites` on `deployment.railway`: the service's source.
- An abstract `deployment.railway` is a template and is never rendered; each environment's
  deployment `extends` it and holds only its differences. Fixture `railway-emit-environments`
  renders both environments from one model (golden output); `abstract-deployment-with-environment`
  loads a base that names an environment beside its concrete child.
- `deploy/unexpressed.md` also lists `@branch` and `@checkSuites` on an `@image` source, and a
  `runtime.process @port` on a deployment with no domain to carry it.
- **Generators**: `.railway/railway.ts` in Railway's Infrastructure as Code format (the `railway`
  npm package 3.17.0's `railway/iac` DSL, a named partial), `deploy/unexpressed.md` (the facts the
  file does not hold), `deploy/sync-secrets.sh` (vault to Railway through `keys-axi`),
  `deploy/deploy.sh`, `deploy/doctor.sh` and a deploy skill. The pack now requires the config pack,
  for settings and vaults. Fixtures `railway-emit-one-service` and `railway-emit-two-services`,
  with golden output, and a coverage test that holds the generated file to every fact of the
  hand-written configuration the fixtures are modelled on. The generated file type-checks against
  the SDK and names, beside each service and variable, the model node it comes from. TypeScript port.
