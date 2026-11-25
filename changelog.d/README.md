# Changelog fragments

Do not edit the `## [Unreleased]` section of `CHANGELOG.md` in a pull request. Add **one new file
here per change** instead. Every PR that edits the top of `[Unreleased]` touches the same lines,
so two PRs in flight conflict as soon as one lands. Two PRs that each add their own file do not.

At release time `scripts/release.mjs` puts every fragment at the top of `[Unreleased]`, in
file-name order, and deletes the files. The release commit then holds one `CHANGELOG.md`, as
before. To fold them in by hand, for example to prepare a release section ahead of the cut, run
`node scripts/changelog-fragments.mjs --assemble`. `--preview` prints the result without writing
anything. When the release's own section was prepared ahead of the cut (a `## [<version>]` heading
already in `CHANGELOG.md`), `release.mjs` stops rather than open a second one: fold the
fragments into that section by hand with `--assemble`, then re-run.

## Format

- **Name:** `<short-slug>.md`, using lower-case letters, digits, `.`, `_` and `-` only, for example
  `csharp-verify-model-lints.md`. Pick a name no other open PR is likely to use: the change's
  subject, not `fix.md`.
- **Content:** the entry exactly as it would read under `[Unreleased]`. That is one top-level
  `- ` bullet, with continuation lines and any further paragraphs or nested bullets indented two
  spaces. Put one change in each file and no `#` heading lines. `scripts/ci-local.sh --only gates`
  checks this (the `changelog fragments` step).

```markdown
- **codegen-ts: the finder name follows the field's column.** A field whose `@column`
  differs from its name now gets `findBy<Column>`. Generated-output change — regenerate to
  pick it up; three-way merge preserves hand edits.
```

The entry conventions in [docs/RELEASING.md](../docs/RELEASING.md) apply to a fragment as they
apply to the CHANGELOG:

- A change to generated output carries the phrase **"Generated-output change — regenerate to pick it
  up; three-way merge preserves hand edits."**
- A change that moves `metamodelVersion` says that it moved, and to what.
- Upgrade notes go in the same bullet, as an indented paragraph that starts `Upgrading:`. The
  release author moves them under the release's `### Upgrading` heading when writing the section.

Fragments are for unreleased work only. A released section of `CHANGELOG.md` is edited in place.
