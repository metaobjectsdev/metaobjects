# Head-to-head: the same app, set up twice

One small app, built two ways, and a script that makes the same six changes to each and records which
checks go red. The result is [SCORECARD.md](SCORECARD.md), written by `./run.sh` from the exit codes of
the checks that ran.

**Who measured it.** The MetaObjects maintainers wrote both setups, the scenarios and the harness. The
numbers are self-measured. We tried to make the baseline competent, but we chose its tools, so read the
setup and change anything you disagree with; `./run.sh` reruns the lot.

## The app

A customer record, a TypeScript HTTP API over Postgres, and a Python worker that renders a welcome prompt
for a customer (the prompt is where an LLM call would go; this demo makes none).

| | DIY baseline (`baseline/`) | MetaObjects (`metaobjects/`) |
|---|---|---|
| Source of truth | TypeSpec (`spec/main.tsp`) for the API and the prompt payload; plain SQL (`atlas/schema.sql`) for the database | One model (`metaobjects/meta.crm.yaml`) |
| TypeScript side | `openapi-typescript` types from the generated OpenAPI; hand-written Fastify handlers over raw `pg` SQL | `meta gen` entity and Zod schema; hand-written Fastify handlers over Drizzle |
| Python side | `datamodel-code-generator` Pydantic models; Jinja2 with `StrictUndefined` | `metaobjects gen` Pydantic models; `metaobjects.render` |
| Database | Atlas versioned migrations, diffed from `schema.sql` | `meta migrate` migrations, diffed from the model |
| Checks in the pull-request gate | regenerate and `git diff --exit-code`; `oasdiff` against the released contract; Atlas migration and lint checks; `tsc`; `mypy`; a pytest that renders the prompt | `meta verify`; `metaobjects verify`; migrations applied to a CI database and `meta verify --db`; `tsc`; `mypy` |

Both use the published packages (npm and PyPI, versions pinned in `package-lock.json` and
`requirements.txt`; the scorecard lists every tool version it measured). Nothing in here needs a checkout
of the MetaObjects source.

`oasdiff` is in the baseline so the partner-contract question has a competent answer on the baseline side.
It is not a MetaObjects feature, and the scorecard says so.

## Run it

You need Docker (Postgres 16, Atlas and oasdiff run as containers), Node.js 20 or newer, `uv`, `git` and
`python3`. The first run installs both setups' dependencies and pulls three images; later runs reuse them.

```sh
./run.sh            # every scenario, both setups, rewrites SCORECARD.md (about four minutes)
./run.sh S1 S6      # chosen scenarios (S0, the control, always runs); prints the scorecard, does not write SCORECARD.md
./run.sh --keep /tmp/h2h-work   # also keep each scenario's working copy and its .ci-logs/
```

Each (setup, scenario) pair gets a throwaway copy of the setup in a fresh git repository: a base commit
of the clean setup, then the scenario's edit plus whatever generators that setup's developer would run,
then a "change" commit, then the setup's own `./ci.sh`. The repository is not touched. One Postgres
container is started for the run and removed at the end.

## The scenarios

Every scenario edits **the place that setup treats as its source of truth**, runs **the generators that
setup gives you** (for MetaObjects that includes `meta migrate`), and leaves the hand-written code and the prompt alone. S1's description in the scorecard spells out what it edits in each setup. That is the premise: it measures what happens when
someone forgets the rest, not how well anyone remembers it. S0 changes nothing and must be green on both
sides, otherwise a red cell elsewhere would be noise.

| | Change | Why it is in the set |
|---|---|---|
| S1 | Rename `Customer.email` to `contactEmail` | one name in many layers |
| S2 | Add a required `country` field | a new column the API now demands |
| S3 | Change a prompt variable to one the payload does not have | prompt drift |
| S4 | Add a field and skip every generator | forgotten regeneration |
| S5 | `ALTER TABLE` a live database by hand | database drift (checked against the live database) |
| S6 | `name` becomes required on `POST /customers` | a change that breaks callers outside the project |

The exact edits are in `harness/run.py` (functions `s1_baseline` … `s6_metaobjects`).

## How to read the scorecard

There are two questions and the scorecard asks them separately, because one tool answering one of them says
nothing about the other.

1. **Do the layers stay consistent?** A model, generated code, a database, a prompt and some hand-written
   code have to agree. *Red* means a check noticed they did not. *Green* means none did; it does not mean
   the change was safe, which is why a happy-path **probe** (create a customer through the API, render its
   prompt in the worker; the same files in both setups) is reported beside it. The probe is informational
   and is not part of either gate.
2. **Does a breaking change for outside callers get flagged?** Only the baseline has a check for this
   (`oasdiff`). MetaObjects 1.2.0 has no equivalent, so every pull-request row in that table reads "no such
   check" for it (S5 is `n/a` on both sides). A change can be perfectly consistent across every layer and
   still break a partner; consistency checks
   cannot see that, and this is the one place the baseline is simply ahead.

### Our reading of the rows that need explaining

These are interpretation, written by hand, not measured. Check them against the logs (`--keep`).

- **S2, baseline.** The baseline's only red check is the partner-contract diff. Nothing ties the API model to
  `atlas/schema.sql`, so the API now requires `country` while the database has no such column, and the raw-SQL
  handler never reads it, so the probe passes. A team that edits `schema.sql` in the same change closes the
  gap by hand; the scenario is "forgot to".
- **S2, MetaObjects.** Every generated layer moved together (the table, the Zod schema, the Pydantic model)
  and the migration was proposed, so no layer check has anything to say. The probe fails because the client
  in the probe does not send `country`, which is the partner-break row again, not layer drift. The
  migration it proposed carries a warning that adding a required column fails on a table that has rows;
  the harness prints it under *authoring*.
- **S3.** The baseline fails at render time (`StrictUndefined`), in a test. MetaObjects fails at
  `verify` time with `ERR_VAR_NOT_ON_PAYLOAD`. At runtime MetaObjects' renderer is lenient and silently
  drops the unknown variable, which is why the probe fails there with a prompt that has no name in it.
  `verify` has to be in your pipeline for that to matter.
- **S6.** MetaObjects has no check for this. The change is legal everywhere in the project and breaks
  only callers outside it.

## Lines each setup needs

The scorecard also counts what each setup makes you write. One rule for both: every committed file in the
setup's directory counts, except lock files, `.gitignore`, machine-generated output (`generated/`, the migrations,
`.metaobjects/.gen-state/` and so on, all listed in the scorecard) and the smoke probe, which is
byte-identical in both. Blank lines and comment-only lines are not counted. `harness/lines.py` fails if a
file fits no category, so nothing escapes the count. Generated lines are reported, not hidden.

## What this does not measure

- **Agent speed, agent cost or agent defect rates.** No LLM wrote any of this and none ran. It says nothing
  about how fast or accurately a coding agent works against either setup.
- **Runtime behaviour beyond a happy path.** The probe creates one customer and renders one prompt. Neither
  setup has the integration or contract tests a production service would; both would add some.
- **Anything outside these six changes.** Six scenarios on one small entity, two languages, one database.
  Do not read the result as a statement about larger models, other stacks, other databases, or other
  scenarios.
- **Authoring effort or skill.** The line counts are a rough size, not a time.

## Known limits of the comparison

- The baseline's handlers use raw SQL, which is what a team often writes when it wants no ORM. That makes
  the database invisible to `tsc`, so a column change reaches the baseline's checks only through the Atlas
  and OpenAPI paths. A baseline built on an ORM would be checked differently.
- The baseline developer edits `spec/main.tsp` as the source of truth and does not edit `atlas/schema.sql`
  in the same change, in every scenario. A team that updates both by hand would see a different result in
  S1 and S2. MetaObjects derives the table from the model, which is the point of the comparison, but it is
  also why MetaObjects' API shape and table shape are coupled (S6: a field required on the API becomes
  `NOT NULL` in the table).
- The baseline's handlers do not validate request bodies at run time; the OpenAPI types only exist at
  compile time. MetaObjects' handlers validate with the generated Zod schema and answer 400. A baseline team
  would add a validator, and that is not counted.
- Which tools make up "a competent baseline" is a judgment. TypeSpec, `openapi-typescript`,
  `datamodel-code-generator`, Atlas, `oasdiff` and a `StrictUndefined` render test are real tools in real
  use; a different team might pick Prisma, or Buf, or hand-write the schema.
- Both setups' gates run only the checks listed above. Each could carry more.

## Layout

```
baseline/      the DIY setup: spec/, atlas/, api/, worker/, prompts/, tests/, ci.sh
metaobjects/   the MetaObjects setup: metaobjects/ (the model), api/, worker/, prompts/, ci.sh
harness/       run.py (scenarios, checks, scorecard) and lines.py (the line counter)
run.sh         entry point
SCORECARD.md   the output of the last run, committed
```
