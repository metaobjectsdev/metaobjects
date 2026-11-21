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
modification time; the check sees only files git reports, so a gitignored path is not checked), then runs the drift gate, your build, your tests and your database commands.
A command you do not pass is reported `skipped`, never `passed`. However the run ended, including a
`link` that failed partway, it puts the estate back on the commit it started on: it unlinks, then runs
`git reset --hard` and `git clean -fd`. That deletes every untracked file in the estate, the regenerated
output included, so the estate must start clean and `--report` must name a file outside it (a path
inside the estate is refused). `--keep-linked` skips the restore and leaves the link and the
regenerated tree in place. `--no-link` skips link and unlink but still restores the estate. `--help` lists the per-port defaults and the flags that
override them. Rust has no estate path: a Rust consumer pins the commit
(`docs/features/prerelease.md`, "Rust").

## Every candidate, every estate (the base run)

1. Link the candidate, install clean, and read the installed versions back. *(script)*
2. Regenerate. Then regenerate again: **the second run must write zero files.** *(script)*
3. `verify` with the drift gate on. Build. Run the estate's tests. *(script, given the commands)*
4. On an estate with a database: `meta migrate --dry-run` and, on Postgres, `meta verify --db`.
   Schema is owned by the Node `meta` in every port, so a non-TypeScript estate runs these from a
   TypeScript install. *(script, given `--db-cmd`)*
5. Boot the app and compare a few API answers with the released version. *(by hand or agent)*
6. Record: files changed, time taken, every failure with its message. Unlink. *(script)*

## What each candidate adds

**rc.1, "as built".** Every diff must be explained by an item in the CHANGELOG upgrade list
("Upgrading from 1.2.0"). A diff that is not there is a CHANGELOG defect or a bug, and it is
fixed before rc.2. Watch for:

- `400 unknown_fields` from forms that post whole records;
- one view replacement per view that joins through a required reference;
- new `verify --db` failures on a foreign key onto a hand-made unique index;
- `RESTART WITH` in the first C# EF migration;
- classes missing on JVM estates whose pom carries `<filters>`;
- owned generator copies that no longer load;
- a template that now raises on a misspelt variable.

**rc.2, new output, TypeScript and Python estates.**

- Expect every generated file to change once, in layout only. Check it by formatting the old and
  the new tree with the estate's own formatter and comparing: what remains must be empty or listed.
- Count hand-edited generated files. On TypeScript the three-way merge conflicts more than usual,
  because the base layout changed under every edit. Move edits into hooks or owned generators
  first where that is possible, and report the count.
- Owned generator copies from 1.2 must still load and generate.
- Commit the new hash manifest (`.metaobjects/.gen-state/.hashes/`). The end-of-run restore wipes it,
  so run with `--keep-linked`, commit the manifest in the estate, then `prerelease-link.sh unlink`.
- C#, Java and Kotlin estates run the base run only and must see **no** diff against rc.1.

**rc.3, new output, C#, Java and Kotlin; TypeScript service code.**

- C#, Java and Kotlin estates: the same one-time layout diff. There was no formatter before, so the
  check is compile plus tests plus the API comparison.
- TypeScript and Python estates: the base run only, no diff against rc.2.
- One or two TypeScript estates pilot the service code on one package (the rc.4 steps below),
  before four ports copy the design.

**rc.4, service code everywhere.** On every estate:

1. Pick one package that has a real status field. Declare its lifecycle (states and transitions),
   one real operation, and its permission points.
2. Add the service generators for that package only, using the port's filter. Leave the other
   packages on the existing generators, which proves the two coexist.
3. Write the policy, the operation bodies and the event hook against the generated interfaces.
   Supply the actor resolver.
4. Call the service from one caller that is not HTTP (a job or a test) and confirm it gets the
   same refusals.
5. Report what the vocabulary could not express. The vocabulary is experimental, and this is the
   last point where it can change cheaply.

## The report

Attach the script's report to the estate's tracking note, plus: the manual step 5 result, the
hand-edit count (rc.2), and any diff the upgrade list did not explain. A failure is a finding
with its message and the step that raised it, never a summary.
