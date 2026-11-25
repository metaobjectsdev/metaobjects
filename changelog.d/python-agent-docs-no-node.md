- **Python: `metaobjects agent-docs` writes the shipped agent files itself, with no Node.** It used to
  print a redirect to `npx meta agent-docs --server python` and exit 1. It now copies
  `.metaobjects/AGENTS.md` and the `metaobjects-*` skills for the stack (`--server`, `--client`,
  default `python`; `--out`; `--no-wire-root`) out of a copy of `agent-context-shipped/` that the
  wheel carries, pins the guide links to the release tag (a prerelease keeps `main`), and matches
  `npx meta agent-docs` byte for byte for the same stack, including the `-migrate` stack it picks
  when `.metaobjects/config.json` sets `migrate.dialect`. A re-run writes nothing for an unchanged
  file, parks fresh text at `<file>.new` beside a hand-edited one, and rewrites the sidecar manifest
  only when it changed. `--skills-dir` and `--no-skills` remain Node-CLI flags. The `gates` lane
  fails when the copy drifts (`scripts/sync-python-agent-context.sh` refreshes it).
