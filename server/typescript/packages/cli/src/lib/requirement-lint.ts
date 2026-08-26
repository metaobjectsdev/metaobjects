// `meta verify` — the requirement AUTHORING lint.
//
// A different kind of claim from the gate in `requirement-check.ts`, which is why
// it is a separate function rather than more branches inside `checkRequirements`.
//
//   THE GATE   referential integrity — links sit at or below the floor, nesting
//              agrees with levels, references resolve. A finding there means the
//              ledger DISAGREES WITH THE MODEL.
//   THE LINT   authoring quality — the name is addressable, the prose slots hold
//              distinct content, nothing was written into a slot no surface reads.
//              A finding here means the ledger is INTERNALLY WASTEFUL: it still
//              agrees with the model, it just records less than its author thinks.
//
// Keeping them apart is not tidiness. `meta verify` prints at most 20 warnings, and
// a ledger with 240 entries can produce hundreds of prose findings — enough to push
// every WARN_REQUIREMENT_OBJECT_UNCLAIMED off the end of the list. Two sections with
// two caps means the lint cannot drown the gate.
//
// IT READS THE LOADED MODEL, NEVER THE FILES. Extensions and overlays mean the text
// on disk is not the effective model: an attr set in one file and overridden in
// another, or inherited through `extends`, reads differently from every angle except
// the loaded tree. A raw-file linter would be wrong for any project using either.
//
// EVERY FINDING IS A WARNING, BY CONSTRUCTION — not by a switch. Stated as a rule so
// the next check added here follows it: a check newly added to a shipping gate cannot
// be shown not to fire on an estate that already exists, and prose findings that turn
// `meta verify` red on upgrade teach people to switch the gate off, which costs more
// than the padding they caught. The precedent is object coverage, which stayed a
// warning because on one real estate it reported every entity in the repository.
//
// There is deliberately NO severity constant to flip. `verify` prints this section
// with `log.warn` unconditionally and computes its exit code from the GATE alone, so
// a constant here would have promised a promotion it could not deliver. If a check in
// this file ever has to fail a build, the honest move is to move the check into the
// gate — which is a decision about what the check IS, not a severity edit.

import {
  DOC_ATTR_DESCRIPTION,
  DOC_ATTR_SUMMARY,
  DOC_ATTR_TITLE,
  REQUIREMENT_ATTR_COUNTEREXAMPLE,
  REQUIREMENT_ATTR_STATEMENT,
  REQUIREMENT_ATTR_TRACKED_BY,
  // The port's ONE identifier splitter, used here for its word boundaries rather
  // than its underscores: `normalise` lowercases and maps every separator to a
  // space, so `toSnakeCase(name)` and a hand-rolled camel split are identical
  // downstream (checked over 20k random identifiers). Sharing it means the lint
  // splits a name the same way the column/table/kebab namers do — a private copy
  // would silently stop agreeing the day that rule is corrected.
  toSnakeCase,
  type MetaData,
} from "@metaobjectsdev/metadata";
// The SAME collection the gate walks, so the two sections of one `meta verify` run
// address a node identically — and the dotted path each reports is the address the
// requirement-test generator turns into the stub's filename. (Pinned by a test that
// compares this path set against `walkRequirements()`, the generator's own walk,
// rather than leaving the two to agree by inspection.)
import {
  collectAddressedRequirements, type AddressedRequirement, type Diagnostic,
} from "./requirement-check.js";

export const WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE = "WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE";
export const WARN_REQUIREMENT_NAME_READS_AS_PROSE = "WARN_REQUIREMENT_NAME_READS_AS_PROSE";
export const WARN_REQUIREMENT_NAME_RESTATES_STATEMENT = "WARN_REQUIREMENT_NAME_RESTATES_STATEMENT";
export const WARN_REQUIREMENT_PROSE_DUPLICATED = "WARN_REQUIREMENT_PROSE_DUPLICATED";
export const WARN_REQUIREMENT_PROSE_EMPTY = "WARN_REQUIREMENT_PROSE_EMPTY";
export const WARN_REQUIREMENT_INERT_DOC_SLOT = "WARN_REQUIREMENT_INERT_DOC_SLOT";
export const WARN_REQUIREMENT_TITLE_IS_AN_ID = "WARN_REQUIREMENT_TITLE_IS_AN_ID";

/**
 * Characters that break the two things a requirement's `name` IS.
 *
 *   `.`  the dotted-path separator. A name containing one is INDISTINGUISHABLE
 *        from nesting: a single node named "Orders.Recorded" and a node "Orders"
 *        containing a node "Recorded" both produce the path `Orders.Recorded`, so
 *        the address stops identifying one node and the two collide on the same
 *        emitted stub file.
 *   `/`  `\`  path separators. The default stub path is
 *        `requirements/<path>.test.ts`, so a name of `../../thing` writes OUTSIDE
 *        the stub directory — and `owns()`, which is what lets the runner reap a
 *        stub whose requirement was deleted, will never claim it back.
 *   the rest  illegal in a filename on Windows, so the stub cannot be written at
 *        all there. `:` doubles as half of the `::` package separator.
 *
 * Every one of these loads today: the loader constrains a requirement's name no
 * more than any other node's, and nothing downstream re-checks it.
 *
 * A SEAM, recorded so the decision stays visible: the general form of this rule is
 * not requirement-specific at all — a `.` in ANY node's name breaks the dotted
 * child-name addressing the whole metamodel uses — so it arguably belongs in the
 * loader as a cross-port warning, beside WARN_ENUM_NORMALIZE_AMBIGUOUS. It is
 * scoped here because the requirement surface is where it currently bites (a name
 * becomes a stub FILENAME only here), and because promoting it means five ports,
 * expected-warnings.json, conformance fixtures and a metamodelVersion question.
 * That is an FR, not a line in this file.
 */
const UNADDRESSABLE = /[./\\:*?"<>|\p{Cc}]/gu;

/** How one offending character is named in the message, so the author is told which
 *  one to remove rather than left to diff their name against a regex.
 *
 *  Only `.` needs a written entry — the rest are self-describing once quoted, and a
 *  hand-written entry per character was a table that had to be kept in step with
 *  UNADDRESSABLE: adding a character to the regex and forgetting the table printed
 *  a bare code point where the character itself was meant. Derived, so it cannot
 *  drift. */
function describeChar(c: string): string {
  if (c === ".") return "'.' (the dotted-path separator)";
  // A control character has no printable form to quote, so name its code point.
  return /\p{Cc}/u.test(c) ? `U+${c.charCodeAt(0).toString(16).padStart(4, "0")}` : `'${c}'`;
}

/**
 * Word count at which a name stops reading as a label and starts reading as prose.
 *
 * A threshold, and the only one in this file — chosen high on purpose. Five words
 * is still plausibly a label ("Order recording for placed orders"); six is a
 * sentence. Under-firing is the right failure here: renaming a requirement changes
 * its address AND its emitted stub filename, so a false positive asks the author to
 * pay a migration for nothing.
 */
const PROSE_WORD_COUNT = 6;

/**
 * Slots that say nothing on a requirement — and the two deliberate exclusions.
 *
 * `summary` qualifies: `@statement` is REQUIRED on both subtypes and is already the
 * one-line sentence, so a summary beside it can only repeat it, and nothing reads
 * it. `spec/capability-ledger.md`'s requirement attribute table does not list it.
 *
 * `title` is NOT on this list, and an earlier version of this file had it there —
 * wrongly. That same attribute table charters it BY NAME on a requirement ("a short
 * noun-phrase label — `name` is an identifier, this is what an index shows"), which
 * is exactly this node type's situation: a requirement's address renders as a dotted
 * camelCase path. Measured against three real ledgers the ban would have told two
 * adopters to delete 355 authored labels, 123 of which carry words the name does not.
 * That the requirements page does not render `title` yet is a gap in the RENDERER,
 * and a tool reporting its own backlog in an adopter's terminal is noise.
 *
 * `notes` is excluded for the opposite reason: chartered internal-only, so being
 * unrendered is the point of it.
 */
const INERT_SLOTS = [DOC_ATTR_SUMMARY] as const;

/**
 * A catalogue or ticket id at the head of a label — `FR-448 …`, `PLAT-77 …`.
 *
 * The real failure the id case represents is FIELD OVERLOADING, not an unread slot:
 * a citation lives in the display label because nothing else was offered, and
 * `@trackedBy` (free-form, deliberately never resolved) is what was. The measured
 * values carry an id AND a noun phrase — "FR-448 — prompt construction as typed
 * payloads through a render engine" — so the fix is to SPLIT them. Moving the whole
 * string to `@trackedBy` would throw the label away, which is why the message says
 * split rather than move.
 */
const TITLE_IS_AN_ID = /^[A-Z]{2,}[- ]?\d+/;

/** Lowercase, drop everything that is not alphanumeric, collapse the gaps.
 *  Two slots "say the same thing" only if they survive this identically — no
 *  similarity score, no threshold. A fuzzy match on prose produces findings the
 *  author can argue with, and a gate people argue with is a gate people mute. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** Whether `text`'s LEADING sentence says the same thing as `key`. False when the
 *  text is a single sentence — the caller's whole-string comparison covers that.
 *
 *  Newlines are collapsed FIRST. A `description` is routinely authored as a YAML
 *  literal block, so the repeated opening sentence usually wraps — and `.` in a JS
 *  regex does not cross a newline, which made this arm silently miss exactly the
 *  authoring style most likely to trip it. The whole-string arm never had the bug
 *  because `normalise` already flattens whitespace. */
function leadingSentenceMatches(text: string, key: string): boolean {
  const flat = text.replace(/\s+/g, " ").trim();
  const m = /^(.+?[.!?])\s+\S/.exec(flat);
  return m?.[1] !== undefined && normalise(m[1]) === key;
}

/** A resolving string read, normalised so "declared but blank" and "absent" are
 *  distinguishable — the first is a finding, the second usually is not.
 *  `attr()` RESOLVES in TypeScript (ADR-0039), so a requirement inheriting its
 *  prose through `extends` is linted on what it effectively carries. */
function readSlot(node: MetaData, name: string): string | undefined {
  const raw = node.attr(name);
  return typeof raw === "string" ? raw : undefined;
}

/**
 * An OWN-ONLY string read — one of the two sanctioned `own*()` uses in this file
 * (ADR-0039 requires every such call to name its case).
 *
 * The checks split by what they are ABOUT, and the split decides the accessor:
 *
 *   RESOLVING  a check about what a node effectively SAYS. Two slots holding one
 *              sentence is a property of the effective node — a child may override
 *              one slot and inherit the other, and only the resolved pair shows it.
 *   OWN-ONLY   a check about a DECLARATION, whose fix is a single edit at a single
 *              node. `title` set once on an abstract is inherited by every child, so
 *              a resolving read reports it once per child at addresses where the
 *              author will find no `title` to delete — on a ledger using the shared
 *              abstract idiom, one mistake can fill the whole lint cap with lines
 *              nobody can act on where they are pointed.
 */
function readOwnSlot(node: MetaData, name: string): string | undefined {
  const raw = node.ownAttr(name);
  return typeof raw === "string" ? raw : undefined;
}

/** Echo an authored value back inside a message without letting a long one take over
 *  the terminal. Findings are printed one per line and a `description`-length slot
 *  would wrap for a dozen of them. */
function excerpt(value: string): string {
  const LIMIT = 80;
  const flat = value.replace(/\s+/g, " ").trim();
  return JSON.stringify(flat.length > LIMIT ? `${flat.slice(0, LIMIT - 1)}…` : flat);
}

function warn(path: string, code: string, message: string): Diagnostic {
  return { severity: "warn", code, path, message };
}

/**
 * Lint every `requirement.*` node in the loaded model.
 *
 * Returns `[]` for a model declaring none — opt-in by declaration, the same way
 * the gate and the docs surface are, so turning this on by default is a no-op for
 * every project without a ledger.
 *
 * What it CANNOT tell you: whether a statement is true, whether a description is
 * useful, or whether the counterexample would actually falsify the claim. Those
 * are the judgements the ledger exists to record and no check reaches them. Every
 * finding below is about a slot's MECHANICS — is this content reachable, is it
 * distinct from its neighbour, is the name still an address.
 */
export function lintRequirements(
  root: MetaData,
  /** The run's already-collected requirements, when one exists. The lint takes the
   *  ADDRESSES alone rather than the gate's full `RequirementScan`: it has nothing
   *  to do with who claims what, and asking for the claim set would make a
   *  standalone call pay for a resolution it never reads. */
  addressed: readonly AddressedRequirement[] = collectAddressedRequirements(root),
): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const { node, path } of addressed) {
    const name = node.name;

    // -- the name is an address, not prose ------------------------------------
    // EVERY problem with one name is reported in ONE finding. These were two
    // branches of an if/else, so a name that was both padded and dotted reported
    // only the dot: the author fixed it, re-ran, and was told about the padding on
    // a second pass. One name is one edit, so it is one finding.
    const problems: string[] = [];
    const offenders = [...new Set(name.match(UNADDRESSABLE) ?? [])];
    if (offenders.length > 0) {
      problems.push(`contains ${offenders.map(describeChar).join(", ")}`);
    }
    if (name.trim() === "") problems.push("is blank");
    else if (name.trim() !== name) problems.push("has leading or trailing whitespace");
    if (problems.length > 0) {
      out.push(warn(path, WARN_REQUIREMENT_NAME_NOT_ADDRESSABLE,
        `name ${JSON.stringify(name)} ${problems.join(", and ")}. A requirement's name is its ` +
        `address — it is the segment of the dotted path '${path}' and the filename of its generated ` +
        `test stub — so this either collides with nesting or produces a path the stub cannot be ` +
        `written to.`));
    }

    const statementKey = normalise(readSlot(node, REQUIREMENT_ATTR_STATEMENT) ?? "");

    // -- the name is not the claim --------------------------------------------
    // Ordered before the prose-shape check and exclusive with it: when the name IS
    // the statement, "rename it" is the wrong instruction. The instruction is "you
    // have written the claim twice; @statement is the one that is read".
    if (statementKey !== "" && normalise(toSnakeCase(name)) === statementKey) {
      out.push(warn(path, WARN_REQUIREMENT_NAME_RESTATES_STATEMENT,
        `name '${name}' says the same thing as @statement. The claim belongs in @statement, which every ` +
        `surface reads; the name is an address and is better as a short identifier.`));
    } else if (name.trim().split(/\s+/).filter((w) => w !== "").length >= PROSE_WORD_COUNT) {
      out.push(warn(path, WARN_REQUIREMENT_NAME_READS_AS_PROSE,
        `name '${name}' reads as a sentence. The name is an address — the dotted path other entries and ` +
        `the generated stub filename are built from — so a short identifier keeps both legible. Put the ` +
        `prose in @statement.`));
    }

    // -- required prose that is present but says nothing -----------------------
    // The loader enforces PRESENCE (min: 1), never content, so `statement: ""`
    // loads clean today and satisfies a required attribute with nothing in it.
    for (const slot of [REQUIREMENT_ATTR_STATEMENT, REQUIREMENT_ATTR_COUNTEREXAMPLE]) {
      // OWN-ONLY: the fix is deleting or filling one declaration. See readOwnSlot.
      const value = readOwnSlot(node, slot);
      if (value !== undefined && value.trim() === "") {
        out.push(warn(path, WARN_REQUIREMENT_PROSE_EMPTY,
          `@${slot} is declared but empty. The loader requires the attribute to be present, not to say ` +
          `anything — an empty one passes every check while recording nothing.`));
      }
    }

    // -- two slots holding one sentence ---------------------------------------
    // The padding failure the authoring guidance names: restating the claim under a
    // second heading reads as diligence and makes every later reader trust the
    // ledger less. Only EXACT repeats are reported, whole or as the description's
    // leading sentence; paraphrase is the broader failure and no mechanical rule
    // reaches it without inventing findings.
    if (statementKey !== "") {
      // No blank-check needed: this arm only runs when `statementKey` is non-empty,
      // and a blank description normalises to "" — which cannot equal it. That makes
      // this guard identical to the `counterexample` arm below.
      const description = readSlot(node, DOC_ATTR_DESCRIPTION);
      if (description !== undefined) {
        if (normalise(description) === statementKey) {
          out.push(warn(path, WARN_REQUIREMENT_PROSE_DUPLICATED,
            `description repeats @statement verbatim. @statement already IS the description of what the ` +
            `requirement is; description holds the SCOPE — what the claim covers, what it deliberately ` +
            `does not, which sibling entry owns the rest. If the scope is obvious, leave it off.`));
        } else if (leadingSentenceMatches(description, statementKey)) {
          out.push(warn(path, WARN_REQUIREMENT_PROSE_DUPLICATED,
            `description opens by repeating @statement verbatim, then continues. Drop the first sentence — ` +
            `it is already read from @statement, and description is only the scope that follows it.`));
        }
      }

      const counterexample = readSlot(node, REQUIREMENT_ATTR_COUNTEREXAMPLE);
      if (counterexample !== undefined && normalise(counterexample) === statementKey) {
        out.push(warn(path, WARN_REQUIREMENT_PROSE_DUPLICATED,
          `@counterexample repeats @statement verbatim. It must describe what BREAKING the claim looks ` +
          `like — the thing you could point at to falsify it — which is what makes the claim checkable.`));
      }
    }

    // -- content written where nothing reads it --------------------------------
    for (const slot of INERT_SLOTS) {
      // OWN-ONLY: the fix is deleting one attribute. See readOwnSlot.
      const value = readOwnSlot(node, slot);
      if (value === undefined || value.trim() === "") continue;
      out.push(warn(path, WARN_REQUIREMENT_INERT_DOC_SLOT,
        `@${slot} says nothing here that @${REQUIREMENT_ATTR_STATEMENT} does not. A requirement's ` +
        `statement is REQUIRED and is already the one-line sentence, so a summary beside it can only ` +
        `repeat it — and no requirement surface reads it. Its content is invisible: ${excerpt(value)}. ` +
        `Delete it. (@title is different and is NOT flagged: it is chartered as the entry's LABEL, ` +
        `because a requirement's name is an identifier.)`));
    }

    // -- an id is not a label -------------------------------------------------
    const title = readOwnSlot(node, DOC_ATTR_TITLE);
    if (title !== undefined && TITLE_IS_AN_ID.test(title.trim())) {
      out.push(warn(path, WARN_REQUIREMENT_TITLE_IS_AN_ID,
        `@title opens with a catalogue or ticket id: ${excerpt(title)}. A title is a NOUN PHRASE and ` +
        `an id is not a name, so this is two things in one slot. SPLIT them — put the id in ` +
        `@${REQUIREMENT_ATTR_TRACKED_BY}, which is the free-form reference slot and IS read, and leave ` +
        `the phrase as the title. Moving the whole string would throw the label away.`));
    }
  }

  return out;
}
