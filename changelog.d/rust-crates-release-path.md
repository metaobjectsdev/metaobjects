- **The Rust crates join the release path (ADR-0065 Amendment 3).** The workspace version moves to
  the shared line (1.3.0), and `scripts/release.mjs` publishes the four crates to crates.io after
  npm, behind the same confirm, in dependency order, when a file they ship changed since the last
  `rust-v*` tag (or they never shipped, or `expected-registry.json` moved); `--crates=publish|skip`
  overrides. Its preflight checks the crates.io token and that the version is free before anything
  is bumped. `docs/RELEASING.md` names crates.io as the fifth registry. Nothing is published.
