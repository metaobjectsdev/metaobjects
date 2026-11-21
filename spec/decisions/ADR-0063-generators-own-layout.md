# ADR-0063: Generators own their layout; formatters are test oracles only

## Status

**Accepted** (2026-11-14). Registers no vocabulary: `metamodelVersion` does not move. It sets
how every port's generators produce text. This decision ships the TypeScript writer, the shared
writer contract and corpus, and the test that holds generator source to the rule. It converted no
generator and changed no generated output. Each generator is converted in its own later change;
the Python writer and its first conversions are in [The Python writer](#the-python-writer).

## Context

The Java `codegen-base` direct family (`FileIndentor` and `FileDirectWriter`, about 130 lines)
gives layout that is correct by construction. A generator writes one line per statement, and
the writer puts it at the current indent. There is no later pass that can fail, be skipped, or
change with a tool version. Generators written since then use weaker techniques:

- **TypeScript** builds files from ts-poet `code` templates with hand-typed indentation and
  `",\n"` joins. It runs dprint (120 columns) over the result, and then Biome (80 columns) over
  most `.ts` files. Formatting is about 97% of per-file generation time. Both formatters swallow
  a failure and write the unformatted text. Neither can fix structure: imports typed as text end
  up in the middle of a file, and blank lines depend on each template's literal edges.
- **Python** runs two `ruff` subprocesses per file and returns the text unformatted when `ruff`
  is not installed. The bytes an adopter gets therefore depend on whether `ruff` is installed,
  and on which version.
- **C#, Java Spring and Kotlin** build strings with indentation typed inside the literals and
  import lists written by hand.

The Java design lost ground because it stopped at indentation. It had no imports, no long-list
wrapping and no optional members. Once a generator types its commas by hand, it may as well type
its spaces too, and nothing stopped that.

## Decision

1. **The generator owns layout.** A generator says what a line contains, and a writer in its own
   port decides where the line sits. The writer builds the file in memory and returns a string.
   It never parses text: it lays out the structure the generator handed it (lines, blocks,
   blank-line requests and breakable lists).

2. **No formatter runs in the generation path, in any port.** No formatter runs in `meta gen`,
   `dotnet meta gen`, `mvn metaobjects:generate` or `metaobjects gen`, and none runs in a
   reference generator. Generated output therefore depends only on the generator and the
   model. The existing formatter entry points (`Code.toString()` with dprint, `formatTs` with
   Biome, Python `ruff_format`) stay exported for adopter-owned generators, because an owned
   copy calls them itself (ADR-0034). Retiring them is a separate decision.

3. **Formatters are test oracles only.** A formatter may run in a test to check output, never
   in a step an adopter's generation depends on.

4. **Output aims for clean, simple code, not parity with today's formatting.** A conversion
   does not have to reproduce the bytes the formatters produce now. When the simple writer
   rules give a different but clean result, the writer's result is right. A conversion is
   checked in one of two ways:
   - format the old output and the new output with the same oracle formatter and compare the
     results; or
   - build the generated code and run its tests (the codegen-compile gate, the api-contract
     corpus and the port's goldens).

   The goldens move when a conversion lands, and the change lists what moved and why.

5. **One writer contract, one writer per port.** Each port has a language-neutral core (lines,
   indentation, blocks, blank-line requests, fit-or-break lists, one output form) and a dialect
   for the language it writes (import collection and ordering, string quoting, doc comments).
   The contract is [`spec/code-writer.md`](../code-writer.md). The shared cases live in
   `fixtures/writer-conformance/`: `core` cases run on every port's writer, and dialect cases
   on the writer for that language. A language's own facility may be the base of its writer
   where one fits (C#'s `IndentedTextWriter` for indentation, Java text blocks and C# raw
   strings as input to the snippet call). It is not adopted when it would make generator source
   stop reading like the file it writes; builder APIs such as JavaPoet and Roslyn
   `SyntaxFactory` are not adopted for that reason.

6. **Each port has a ratchet against hand-typed layout.** A test reads generator source and
   fails on layout typed by hand: a string literal holding a line break, a string that starts a
   line with an indentation run, a join on a newline, or an indentation built with `repeat`.
   The test parses the source with the language's own parser and walks the syntax tree. It does
   not match patterns over the text, so comments are never findings and a constant cannot hide
   a newline. Test files, the writer itself and build-script output are excluded by rule. An
   allowlist names every unconverted file, each with a written reason, and only shrinks. A file
   that stops typing layout must drop its entry. TypeScript's ratchet is
   `server/typescript/packages/codegen-ts/test/layout-ratchet.test.ts`, and the other ports add
   theirs with their writers.

7. **Reference generators are extended by subclassing.** Ejecting a generator and maintaining
   the copy (ADR-0034) stays available, but it is not the only way to change one. An adopter may
   extend the reference generator's class and override the few methods it needs, and keep
   taking every other change the reference gets. So:
   - each reference generator is a class, and each meaningful piece of its output (the file
     header, the imports, each section or member) comes from its own overridable method;
   - nothing an adopter might want to change is `final`, `private`, `sealed`, `#private` or a
     module-private helper only; it is `protected` or public;
   - the generator config or registry accepts an adopter's subclass wherever it accepts the
     reference generator (in TypeScript it already does, since `generators` takes any
     `Generator` object);
   - `CodeWriter` and `TsWriter` are not final, and their methods are overridable, so a
     subclass can change one layout step, such as import order or where a line breaks.

   **This is not a stability contract.** Overridable methods may be renamed, split or have
   their signatures changed between minor versions, and the CHANGELOG notes it when they do.
   An adopter who needs a contract ejects. The ratchet in item 6 does not enforce this rule;
   review does. Existing generators take this shape as each one is converted to the writer.

## The TypeScript writer

`CodeWriter` and `TsWriter` (`server/typescript/packages/codegen-ts/src/writer/`) are exported
from the package root and from `@metaobjectsdev/codegen-ts/engine`, and both are listed in
`eject.engineSurface`, so an owned generator imports them from the package. TypeScript lays out
at **120 columns** with a two-space indent and a trailing comma in broken lists.

`TsWriter` accepts `Code` fragments from the package's code primitives (`src/poet.ts`, the
vendored ts-poet printer). A fragment is written as its text, its `imp()`
symbols join the file's import block, and a multi-line fragment is re-indented by
`w.code(fragment)`. A generator can therefore move to the writer one function at a time while the
sections it has not converted still return `Code`. A `Code` built by a different physical copy of
those primitives cannot be read, so it is refused rather than written without its imports.

## The Python writer

`CodeWriter` and `PyWriter` (`server/python/src/metaobjects/codegen/writer/`) are exported as
`metaobjects.codegen.writer` and listed in `eject.engineSurface.python`. Python lays out at
**88 columns** with a four-space indent and a trailing comma in broken lists. Its runner is
`server/python/tests/codegen/test_writer_conformance.py`. The `output-prompt`, `report-export` and
`filter-allowlist` generators write through it and no longer call `ruff`. Every other Python
generator still types its own layout: `tests/codegen/layout_ratchet/allowlist.json` lists those
files, the layout check (`tests/codegen/test_layout_ratchet.py`) fails on any new one, and an entry
is removed when its generator converts, so the list only shrinks. The dialect contract is in
[`spec/code-writer.md`](../code-writer.md).

## Consequences

- Generation gets faster and becomes deterministic. Once a generator is converted, no formatter
  version, configuration file or missing binary can change its bytes.
- Imports are collected while the body is written, so structural defects that a formatter could
  never fix (mid-file imports, duplicate imports) go away with the conversion.
- Generated files change once per port as generators convert. A hand-edited generated file gets
  the usual three-way merge against the new base.
- The writer stays small because it never parses text. A shape the fit-or-break rule lays out
  badly is broken explicitly by the generator with a block, rather than by making the writer
  smarter.
- Adopters can change one piece of a reference generator without owning all of it. The price
  is that an override can break on a minor upgrade, which is the trade item 7 accepts.
- Five writers must agree, which the shared corpus checks, as the repository already does for
  everything else that must match across ports.
