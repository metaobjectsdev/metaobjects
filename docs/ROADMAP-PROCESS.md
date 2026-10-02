# Roadmap process — GitHub is the source of truth

How we track features and releases. **Changed 2026-10-02:** status, priority and target release
moved from `spec/roadmap.md` into GitHub. The file-based registry had drifted from both the code
and the issues (an audit that day found six FRs shipped while the file still listed them as
planned or active, and eight live FRs with no issue at all). One place to update is the fix.

## Where each fact lives

| Fact | Lives in | Not in |
|---|---|---|
| A feature exists, its scope summary, its status | the GitHub **issue**, labelled `FR` | `spec/roadmap.md` |
| Target release | the issue's **milestone** (`1.1`, `1.2`, `1.3`, `1.4`, `1.x (later)`) | `spec/roadmap.md` |
| Work in progress | the **MetaObjects Roadmap** project board's `Status` field (Todo / In progress / Done) | — |
| The design (why and how) | `docs/superpowers/specs/*`, ADRs in `spec/decisions/*` — linked from the issue, never copied into it | the issue body |
| Release direction, FR number → issue → spec index, future themes, history | `spec/roadmap.md` | — |
| What shipped in which version | `CHANGELOG.md` | — |

**An issue labelled `FR` with no milestone is untriaged.** Triage means giving it a milestone or
closing it.

## FR numbers

A feature gets an `FR-0NN` number when it gets a design spec, because the number names the spec
file and is cited across docs. Small feature requests can stay as plain `FR`-labelled issues
with no number. Allocate the next number as the highest in `spec/roadmap.md`'s feature index + 1.

## The rules

1. **New feature.** Create the issue first, labelled `FR` plus an `area:*` label, with a
   milestone if one is known:
   ```sh
   gh issue create -R metaobjectsdev/metaobjects \
     --title "FR-0NN — <title>" --label "FR,area:<x>" --milestone "<1.x>" \
     --body-file <file>   # one-paragraph summary, then the spec link and the target release
   ```
   If it has a spec, add one row to the **feature index** in `spec/roadmap.md`
   (FR | title | issue | spec) in the same change that adds the spec. The index has no status
   column on purpose.
2. **Status or target release changes.** Change the issue (milestone, board `Status`, a comment
   saying what changed and why). Nothing to edit in the repo.
3. **Shipping.** Close the issue with a comment naming the version and the commit or PR. Partial
   delivery: comment what shipped and what remains, and keep it open (or split the remainder into
   a new issue and close the original).
4. **Cutting a release.** Every issue in the milestone is closed or moved to a later one, then the
   milestone is closed. `CHANGELOG.md` remains the record of what shipped.
5. **When the spec and the issue disagree about status, the issue wins.** Specs are design
   records; they are not kept current with delivery.

## The project board

"MetaObjects Roadmap", owned by the `metaobjectsdev` organisation:
- a built-in **Auto-add** workflow adds every issue in this repo labelled `FR`;
- the default view is grouped **by milestone** (the release columns);
- a `Status` single-select (Todo / In progress / Done).

The board is a view over the issues, so losing or rebuilding it costs nothing. Creating or
scripting it needs the token's `project` scope: `gh auth refresh -s project,read:project`.

## Public roadmap (website)

The adopter-facing roadmap on `metaobjects.dev/roadmap` (Now / Next / Later) is summarised from
the milestones: Now = the next minor's open `FR` issues, Next = the one after, Later =
`1.x (later)`. Refresh it when a milestone's contents change.
