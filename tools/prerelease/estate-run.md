# Running an adopter estate against a staged candidate

A candidate (`1.3.0-rc.N`) is proved on real estates before the next one is cut. Every corpus in
this repository can be green while an application built on the release is broken, because the
defects live where features meet, in models no fixture composes. This page is the run sheet
(1.0 gate G3d, `docs/RELEASING.md` §2c, is the same idea for the final cut). An agent does the
run; nobody needs to do it by hand.

Publishing the candidate is `bun run prerelease:candidate`
([docs/features/prerelease.md](../../docs/features/prerelease.md), "Staged candidates"); the commit
each candidate was built from is in [candidates.md](candidates.md).

## The mechanical part: `estate-run.sh`

```bash
tools/prerelease/estate-run.sh --project <estate-dir> --port ts|python|csharp|java \
    --version 1.3.0-rc.N --build-cmd '<build>' --test-cmd '<tests>' \
    [--db-cmd '<command>']... [--report <file>]
```

It refuses an estate whose git tree is not clean, links the candidate, installs clean and **reads
the installed versions back** (a declared range is not proof of the version that ran: the run
fails when the candidate is not in the read-back), regenerates and lists every changed file,
regenerates **again** and requires that the second run writes zero files (by content and by
modification time; the check sees only files git reports, so a gitignored path is not checked: see
"Multi-module JVM estates" below), then runs the drift gate, your build, your tests and your database commands.
A command you do not pass is reported `skipped`, never `passed`. However the run ended, including a
`link` that failed partway, it puts the estate back on the commit it started on: it unlinks, then runs
`git reset --hard` and `git clean -fd`. That deletes every untracked file in the estate, the regenerated
output included, so the estate must start clean and `--report` must name a file outside it (a path
inside the estate is refused). `--keep-linked` skips the restore and leaves the link and the
regenerated tree in place. `--no-link` skips link and unlink but still restores the estate. `--help`
lists the flags. The default install, generation, verify and version-read commands for each port
are in the `case` block of `estate-run.sh`; `--install-cmd`, `--gen-cmd`, `--verify-cmd` and
`--versions-cmd` override them. Rust has no estate path: a Rust consumer pins the commit
(`docs/features/prerelease.md`, "Rust").

### Multi-module JVM estates

The Java default install is `mvn -B -q -U test-compile`: it builds every module of the reactor in
order, so a module whose code or tests depend on a sibling module resolves it from the reactor
instead of looking for it in a repository nobody installed it to. It also runs `generate-sources`,
so an estate that binds a `generate` execution to that phase regenerates during the install: the
report lists those files under "Files changed by install", separately from the lockfile and before
the first gen, and every one that is not a lockfile needs an item in the upgrade list like any other
change. Two more things the defaults do not cover, which the estate passes itself:

- **Generation bound to a lifecycle phase.** The default `--gen-cmd` (`mvn -B -q
  metaobjects:generate`) and `--verify-cmd` (`mvn -B -q metaobjects:verify`) call the goals on
  their own, from the reactor root. An estate that binds generation to a phase in its poms, or
  whose metadata loader class lives in a sibling module (the goal then fails with the loader
  "not found on the Project ClassLoader" until that module is compiled), passes the phase that
  runs it instead: for example `--gen-cmd 'mvn -B -q generate-sources'` (the install already ran
  that phase once, so this gen and the second one must both find nothing left to write), or
  `--gen-cmd 'mvn -B -q test-compile'` when the loader must be compiled first, and the matching
  `--verify-cmd` (the `metaobjects:verify` execution as the estate binds it, such as
  `mvn -B -q verify -DskipTests`).
- **Generated output that git ignores.** The changed-files list and the second-run check see
  only files git reports, so output under `target/generated-sources` or another ignored path
  is not looked at. The script runs both gens itself, so snapshot those trees before the run
  and after it (with `--keep-linked`, so the tree survives the run), then run your `--gen-cmd`
  once more and snapshot again: the first diff is the "files changed" list the upgrade list
  must explain, and the second must be empty, by content and by modification time.

## Every candidate, every estate (the base run)

1. Link the candidate, install clean, and read the installed versions back. *(script)*
2. Regenerate. Then regenerate again: **the second run must write zero files.** *(script)*
3. `verify` with the drift gate on. Build. Run the estate's tests. *(script, given the commands)*
4. On an estate with a database: `meta migrate --dry-run` and, on Postgres, `meta verify --db`.
   Both are Node `meta` commands, so a non-TypeScript estate that uses the reference migration
   helper runs these from a TypeScript install. *(script, given `--db-cmd`)*
5. Boot the app and compare a few API answers with the released version. *(by hand or agent)*
6. Record: files changed, time taken, every failure with its message. Unlink. *(script)*

## What each candidate adds

Nothing is published to a public registry at any candidate. Each candidate carries:

| Candidate | What it carries |
|---|---|
| rc.1, "as built" | Main as it stands, a truthful upgrade list, the small fixes and the wording fixes that ship into adopters' repos |
| rc.2, new output, TypeScript and Python | Formatters out of generation; every TypeScript and Python generator on the writer; page size 50 everywhere; libSQL and the first prunes out of the default install; the REST-standard scenarios; reporting and requirements in packs; the `meta schema` command |
| rc.3, new output, C#, Java and Kotlin; TypeScript service code | The JVM and .NET ports converted; Rust's layout check; the TypeScript service generators; the Python `ObjectManager` split; the REST standard in Python |
| rc.4, service code in five ports | Service generators in C#, Java, Kotlin and Python; the REST standard in C#, Java and Kotlin; the docs generators in four ports; Rust's names, contract types and data access |
| rc.5, close-out | Rust's service code, transport and docs generators; one round of vocabulary changes from the estate reports; the authoring-surface snapshots; anything that slipped |

**rc.1.** Every diff must be explained by an item in the CHANGELOG upgrade list
("Upgrading from 1.2.0"). A diff that is not there is a CHANGELOG defect or a bug, and it is
fixed before rc.2. Watch for:

- `400 unknown_fields` from forms that post whole records;
- one view replacement per view that joins through a required reference;
- new `verify --db` failures on a foreign key onto a hand-made unique index;
- `RESTART WITH` in the first C# EF migration;
- classes missing on JVM estates whose pom carries `<filters>`;
- owned generator copies that no longer load;
- a template that now raises on a misspelt variable;
- the model must load identically with the rules and view-expression vocabulary in packs.

**rc.2.**

- **TypeScript and C# estates: find every list call that passes no limit.** It returned every row
  and now returns 50. Check grids, exports, background jobs and tests. Each one pages, passes a
  limit, or the project sets `api.pagination`. This is the change most likely to produce a wrong
  screen without an error.
- TypeScript and Python estates: expect every generated file to change once, in layout only. Check
  it by formatting the old and the new tree with the estate's own formatter and comparing: what
  remains must be empty or listed.
- TypeScript estates: count hand-edited generated files. The three-way merge conflicts more than
  usual, because the base layout changed under every edit. Move edits into hooks or owned
  generators first where that is possible, and report the count.
- TypeScript estates: owned generator copies from 1.2 must still load and generate. An estate that
  migrates SQLite through the CLI adds the libSQL driver. An estate that generates trace helpers
  regenerates and drops the `@metaobjectsdev/ai-runtime` dependency. An estate that uses the Cube
  export adds the Cube package (when that change lands).
- Commit the new hash manifest (`.metaobjects/.gen-state/.hashes/`). The end-of-run restore wipes
  it, so run with `--keep-linked`, commit the manifest in the estate, then
  `prerelease-link.sh unlink`.
- C#, Java and Kotlin estates otherwise run the base run only and must see no other diff against rc.1.
- The model must load identically with reporting and requirements in packs.

**rc.3.**

- C#, Java and Kotlin estates: the same one-time layout diff. There was no formatter before, so the
  check is compile plus tests plus the API comparison.
- Python estates: `ObjectManager(root, driver)` no longer constructs. Use `ObjectManagerDb`. A
  hand-written `Repository` takes a predicate tree instead of a flat list.
- JVM estates: a misspelt generator `<arg>` now fails the build instead of being ignored. A pom
  that lists the `mustache` generator moves to the `template` generator.
- C# estates: an unknown top-level config key now fails.
- TypeScript and Python estates: the base run only, no other diff against rc.2.
- **One or two TypeScript estates pilot the service code on one package** (the rc.4 steps below).
  Four ports are about to copy this design, and an estate will find what the shared tests cannot.

**rc.4.** On every estate:

1. Pick one package that has a real status field. Declare its lifecycle (states and transitions),
   one real operation, and its permission points.
2. Add the service generators for that package only, using the port's filter. Leave the other
   packages on the existing generators, which proves the two coexist.
3. Write the policy, the operation bodies and the event hook against the generated interfaces.
   Supply the actor resolver.
4. Call the service from one caller that is not HTTP (a job or a test) and confirm it gets the
   same refusals.
5. Set each of the four `rules.*` keys away from its default once and confirm the generated code
   or `verify` changes as documented.
6. Report what the vocabulary could not express. The vocabulary is experimental, and this is the
   last point where it can change cheaply.

Also at rc.4:

- Java estates: a hand-written repository implementation takes a predicate tree.
- C#, Java and Kotlin estates: clients may now send `search` and or/and filters; check client
  error handling against the named error bodies (`invalid_json`, `invalid_id`).
- Non-TypeScript estates: regenerate the agent files with the port's own command, with no Node
  installed on the path, and add the requirements page generator.
- One non-TypeScript estate that already uses its own migration tool follows that port's native
  recipe and confirms `meta verify --db` passes.

**rc.5.** The base run, plus rc.4 steps 1 to 4 again on whatever the vocabulary round changed.

**Rust.** There is no Rust estate. The stand-in is an example app in this repository that follows
the rc.4 steps, built against the candidate commit as a git dependency
(`docs/features/prerelease.md`, "Rust"). A Rust project the maintainer prefers replaces it.

## The report

Attach the script's report to the estate's tracking note, plus: the manual step 5 result, the
hand-edit count (rc.2), and any diff the upgrade list did not explain. A failure is a finding
with its message and the step that raised it, never a summary.
