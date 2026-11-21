# Staged candidates

One row per `bun run prerelease:publish` that published, appended by the script and committed by
the person who ran it. `Commit` is the `HEAD` the candidate was built from (`+dirty` when tracked
files outside the version declarations were modified). `Registries` names ecosystems, never
hosts. A Rust consumer pins that commit (docs/features/prerelease.md, "Rust").

| Candidate | Commit | Date (UTC) | Registries |
|---|---|---|---|
