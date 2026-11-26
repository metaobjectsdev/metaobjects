# The code writer contract

Each port's generators write text through a code writer, as that port's writer lands
([ADR-0063](decisions/ADR-0063-generators-own-layout.md)); [`docs/CONFORMANCE.md`](../docs/CONFORMANCE.md)
records which ports have one. The generator says what a line
contains, and the writer decides where it sits. This document is the contract the writers
share. The cases in [`fixtures/writer-conformance/`](../fixtures/writer-conformance/) pin it.

A writer has two parts:

- **The core**, which is language-neutral: lines, indentation, blocks, blank-line requests,
  snippets, fit-or-break lists and the output form. Every port's core runs the `core` cases.
- **A dialect** for the language being written: import collection and ordering, string
  quoting, doc comments and expression helpers. A dialect runs the cases for its language,
  such as `typescript` or `python`.

The writer never parses text. It lays out the structure the generator handed it. When a shape
comes out badly, the generator breaks it explicitly with a block. The writer is not made
smarter.

## Core

### Options

| Option | Meaning | TypeScript default | Java default | Kotlin default |
|---|---|---|---|---|
| `indent` | One level of indentation | two spaces | four spaces | four spaces |
| `width` | The last column a line may reach before its last list breaks | 120 | 120 | 120 |
| `trailingComma` | Whether a broken list puts a comma after its last item too | true | false | true |

A dialect sets the defaults for its language. A `core` case always states all three, so it
means the same thing in every port.

### Lines and blocks

- **`line(parts...)`** writes one line at the current indent. Its parts are concatenated. There
  is no unindented variant.
- **`open(parts...)`** writes the line, then indents one level. **`close(parts...)`** dedents
  one level, then writes the line. **`block(head, body, tail)`** is `open(head)`, then the body,
  then `close(tail)`. A port gives `block` its idiomatic scoped form: a callback in
  TypeScript, `try (var b = ...)` in Java, `with` in Python, `using` in C#.
- Indentation comes only from open blocks, so a line's indent is the depth of the blocks around
  it times `indent`.
- `close` with no block open is **`ERR_WRITER_UNBALANCED_CLOSE`**. Finishing the file with a
  block still open is **`ERR_WRITER_UNCLOSED_BLOCK`**, and the message quotes the line that
  opened the innermost open block.
- Line text containing a line break (`\n`, `\r\n` or `\r`) is **`ERR_WRITER_NEWLINE_IN_LINE`**.
  Write each line separately, or use `text`.

### Blank lines are requests

- **`blank()`** asks for one blank line before whatever is written next.
- Two or more requests in a row give one blank line.
- A request gives nothing at the start of the file, directly after a line that opens a block,
  directly before a line that closes a block, or at the end of the file.
- A line whose text is empty is a blank-line request, not a written line.

### Snippets

**`text(snippet)`** writes a block of fixed code as it should read. The writer splits it on
line breaks (`\n`, `\r\n` and `\r`). It drops the first line when that line is blank, and the
last line when that line is blank. It removes the common left margin of the non-blank lines and
writes each line at the current indent, keeping the line's indentation beyond the margin. A
blank line inside the snippet is a blank-line request. Every line is re-indented, including a
line inside a multi-line string literal in the snippet.

### Lists fit or break

A **list** is an opener, items and a closer. On one line its items are separated by `, `. A
**padded** list puts a space inside its brackets (`{ a, b }`); an unpadded one does not
(`[a, b]`, `f(a, b)`). An empty list prints as its opener and closer (`{}`, `[]`, `()`) and
never breaks.

When a line's indent plus its text is at most `width`, the line prints as it is. When it is
longer:

1. The **last** non-empty list on the line breaks. Everything before it, flattened, plus its
   opener, is a line that opens a block. Each item is a line followed by a comma, except the
   last item when `trailingComma` is false. The closer plus everything after it closes the
   block.
2. Each item line is held to the same rule, so an item that still does not fit breaks its own
   last list.
3. A line with no non-empty list prints as it is, however long.

Width is counted in Unicode code points, so an emoji counts as one even though it is two UTF-16
units. The comparison includes the indent, and a line exactly `width` long fits.

### Output form

- Lines end with `\n` on every platform.
- No line has trailing whitespace.
- A file with any content ends with exactly one `\n`. A file with no content is the empty
  string.
- Text is UTF-8 when it is written to disk.

## TypeScript dialect (`TsWriter`)

- **Imports are collected while the body is written.** `use(name, from)` records a value
  import and returns the name to write; `use(name, from, as)` binds it locally as `as`
  (`import { name as as }`) and returns `as`. `useType` records a type-only import and takes
  the same optional `as`. `useDefault`,
  `useNamespace` and `useSideEffect` record the other forms. Imports print before the body,
  after any `header(...)` lines, with one blank line between each of the three sections.
- **Order.** Package modules come first, then relative ones (those starting with `.`). Each
  group is in code-unit order, with no blank line between the groups. Within a module, names are
  in code-unit order.
- **One line per module.** `import * as ns from "m";` prints on its own line. Default and named
  imports share a line: `import D, { a, type B } from "m";`. A module whose every named import
  is type-only, with no default, prints as `import type { A, B } from "m";`. A name used both as
  a type and as a value is imported as a value. A side-effect import (`import "m";`) prints only
  when nothing else is imported from that module.
- The named list is a padded list and fits or breaks like any other. A single name never
  breaks.
- One local name imported from two modules, or naming two different exports, is
  **`ERR_WRITER_IMPORT_CONFLICT`**.
- **`reopen(parts...)`** closes the open block and opens the next on one line: it dedents,
  writes the line, and indents again, as in `}).superRefine((row, ctx) => {` or `} else {`. With
  no block open it is **`ERR_WRITER_UNBALANCED_CLOSE`**.
- **`doc(lines...)`** writes `/** text */` when there is one entry and it fits. Otherwise it
  writes a block of ` * ` lines, with a bare ` *` line for an empty entry. A `*/` inside the
  text is written as `*\/`.
- **`Code` interop.** Any part may be a `Code` or `Import` from the package's code primitives
  (`src/poet.ts`, the vendored ts-poet printer). Its text is written, and its imports are
  collected. `code(fragment)` writes a multi-line fragment as a snippet. A fragment from a
  different physical copy of those primitives (or from the ts-poet package itself) is refused
  with **`ERR_WRITER_UNKNOWN_PIECE`**, because its imports cannot be read.
- Helpers: `str` (a quoted string literal), `arr`, `call`, `props()` (an object literal built
  with `.set(name, value)` and `.add(member)`) and `key` (an object key, quoted only when it is
  not an identifier).
- `json(value)` writes a JSON value as a literal. Arrays and objects are breakable lists (an
  object is padded, `{ "k": v }`), and object keys stay quoted, as JSON writes them.
- `docSample(writer)` turns a code sample laid out by another writer into doc-comment lines,
  each indented four spaces, for a worked example inside a `doc(...)` comment.
- `legacyMemberLines(members, indent)` is the 1.2 string form of a member list (a line break
  before each member, at `indent`). It exists only for the deprecated `*Line` helpers an owned
  1.2 generator still calls; new code spreads the members into the writer.
- **`indented(body)`** writes nothing itself and writes the body one level in. It is a block
  delimited by indentation alone, as C#'s `Hanging()` and Python's suites are, and is used
  where no line closes the block: the clauses of a SQL view body, or a YAML mapping. The
  TypeScript port's `CodeWriter` has it, so every TypeScript writer inherits it.

### YAML (`YamlWriter`, TypeScript port only)

The TypeScript port also writes YAML (the Cube data model). It has no conformance cases, since
no other port writes YAML. Defaults: two-space indent, no width limit (a flow list is written as
the generator gives it), and no trailing comma.

- **`key(name, body)`** writes `name:` and the body under it, one level in, with no closing
  line.
- **`item(body)`** writes one block-list entry. The first line the body writes carries `- `, and
  the entry's other lines align under that line's text.

## Java dialect (`JavaWriter`)

`JavaWriter` is in `codegen-base` (`com.metaobjects.generator.writer`), beside the core
`CodeWriter`. Its `block(head)` is the scoped form: `try (var b = w.block("class A {")) { ... }`
writes the head, indents, and on leaving the `try` dedents and writes `}`.

- **The package line** is set with `packageName(name)` and prints after the `header(...)` lines
  and before the imports, with one blank line between each section.
- **Imports are collected while the body is written.** `use("pkg.Type")` records an import and
  returns the name to write, which is the type's last segment (a nested type,
  `java.util.Map.Entry`, is imported as written and written `Entry`). `useStatic("pkg.Type.member")`
  records a static import and returns the member name. A type in `java.lang`, or in the file's own
  package, imports nothing, whichever order the package and the types were named in.
- **Order.** Static imports first, then one blank line, then the other imports. Each group is in
  code-unit order, with no blank line between packages. A name used twice is imported once.
- One local name imported from two types, or one static member name from two types, is
  **`ERR_WRITER_IMPORT_CONFLICT`**. A generator that needs both writes one of them fully qualified.
- **`doc(lines...)`** writes `/** text */` when there is one entry and it fits. Otherwise it
  writes a block of ` * ` lines, with a bare ` *` line for an empty entry. A `*/` inside the text
  is written as `*&#47;`.
- Helpers: `str` (a quoted string literal) and `call` (`fn(a, b)`, a list that breaks one item per
  line with no trailing comma).
- A part is a `String`, a list (`Group`, built with `CodeWriter.list` or `CodeWriter.padded`) or a
  `List` or array of parts, which are concatenated. Anything else (a number, `null`, another
  object) is **`ERR_WRITER_UNKNOWN_PIECE`**: the writer never guesses how to print it.

## Kotlin dialect (`KotlinWriter`)

Case `dialect` is `kotlin`. `KotlinWriter` is in `codegen-kotlin`
(`com.metaobjects.generator.kotlin.writer`) and extends the same core `CodeWriter` the Java writer
does. The defaults are four-space indent, width 120 and a trailing comma, as Kotlin's coding
conventions write them.

- **The package line** is set with `packageName(name)` and prints after the `header(...)` lines
  and before the imports, with one blank line between each section. An empty package prints no
  line.
- **Imports are collected while the body is written.** `use("pkg.Name")` records an import and
  returns the name to write, its last segment. `use("pkg.Name", alias)` records
  `import pkg.Name as alias` and returns the alias. A name in a package Kotlin imports by default
  (`kotlin`, `kotlin.collections`, `kotlin.io`, `java.lang` and the rest of the language's default
  imports), or in the file's own package, prints no line. An aliased import always prints.
- **Order.** One group, in code-unit order of what follows `import `, with no blank lines. A name
  used twice is imported once.
- One local name imported from two names is **`ERR_WRITER_IMPORT_CONFLICT`**.
- **Names.** A segment that is a hard keyword (`object`, `in`, `is`, ...) is written in backticks,
  in the package line, in an import and in the name `use` returns.
- **`doc(lines...)`** writes `/** text */` when there is one entry and it fits. Otherwise it
  writes a block of ` * ` lines, with a bare ` *` line for an empty entry. Kotlin comments nest, so
  both `*/` and `/*` inside the text are neutralised (`*&#47;`, `&#47;*`).
- **Scoped forms.** `block(head) { ... }` writes the head, indents, runs the lambda, dedents and
  writes `}`. `reopen(parts)` closes the open block and opens the next on one line (`} else {`);
  with no block open it is `ERR_WRITER_UNBALANCED_CLOSE`. `indented { ... }` writes its lines one
  level in and opens no block: the continuation of an expression body.
- Helpers: `str` (a quoted string literal, with `$` escaped so it is never a template) and `call`
  (`fn(a, b)`, a list that breaks one item per line with a trailing comma).

## Python dialect (`PyWriter`)

Defaults: four-space indent, 88 columns, a trailing comma on a broken list.

- **Imports are collected while the body is written.** `use(name, from)` records
  `from m import name` and returns the name to write; `use(name, from, as)` records
  `from m import name as as`. `use_module(m)` and `use_module(m, as)` record `import m` and
  `import m as as`. `use_future(name)` records `from __future__ import name`. Imports print
  before the body, after any `header(...)` lines, with one blank line between each section.
- **Order.** Three sections: `__future__`, then absolute modules, then relative ones (those
  starting with `.`). Each section is in code-point order, with one blank line between the
  sections. In a section the plain `import m` lines come first, then the `from m import ...`
  lines, each group in code-point order, and names in code-point order.
- **Long import lines.** `from m import a, b` stays on one line when it fits; otherwise it
  prints as `from m import (`, one name per line, each followed by a comma, and `)`. A single
  name never breaks.
- One local name imported from two modules, or naming two different exports, is
  **`ERR_WRITER_IMPORT_CONFLICT`**.
- **Suites.** A Python block has no closing token: the block ends when the indent drops.
  `open` starts a suite and `dedent` ends it without writing a line. A pending blank-line
  request survives a dedent, so the gap before the next definition is kept. (`close` still
  writes its line and drops a pending request, as in the core.) A suite still open when the file
  is finished ends there: Python needs no closing token, so this is not
  `ERR_WRITER_UNCLOSED_BLOCK`. `close` with no suite open, and `dedent` with none open, are
  `ERR_WRITER_UNBALANCED_CLOSE`.
- **`gap()`** asks for two blank lines before whatever is written next (the gap between
  top-level definitions). A later `blank()` does not shrink it. Asked for before the first body
  line, it is the gap after the imports: two blank lines instead of one, so a top-level `class`
  or `def` right after the imports is set off as PEP 8 asks.
- **`doc(lines...)`** writes `"""text"""` when there is one entry and it fits. Otherwise it
  writes the opening quotes with the first entry, each further entry on its own line (an
  empty entry is a blank line) and the closing quotes on their own line. A backslash is
  written as `\\` and `"""` as `\"\"\"`. On one line, a double quote at the end of
  the text is written `\"`, so it cannot join the closing quotes.
- Helpers: `str_lit` (a double-quoted string literal), `call`, `seq`, `mapping` and `kwarg`.

## C# dialect (`CsWriter`)

Case `dialect` is `csharp`. The defaults are four-space indent, width 120 and a trailing comma.

- **Usings are collected while the body is written.** `Using(ns)`, `UsingStatic(type)` and
  `UsingAlias(alias, target)` record a `using`, once. They print after any `Header(...)` lines
  (`#nullable enable` is a header line, `GeneratedFileHeader(name)` writes the generated-file
  marker, the generator's name and `#nullable enable`), with one blank line before the body.
  A file with no usings prints no blank line for them.
- **Order.** `AsWritten` (the default) prints the usings in the order they were recorded, so a
  generator converted to the writer keeps its output. `Sorted` prints `System` namespaces first, then
  the rest, each group in ordinal order of the namespace.
- One alias naming two different targets is **`ERR_WRITER_IMPORT_CONFLICT`**.
- **`Braced(head)`** writes `head`, then a `{` on its own line, indents, and writes `}` when the scope
  ends: the Allman form C# generators emit.
- **`DocSummary(lines...)`** writes `/// <summary>`, one `/// text` line per entry (a bare `///` for an
  empty entry) and `/// </summary>`, at the current indent.
- **`Hanging()`** is a scope for a statement that carries on after a line that is not finished. It
  writes nothing, and indents the lines written inside it by one level. A block opened inside it
  must be closed inside it.

## Rust dialect (`CodeWriter`)

Case `dialect` is `rust`. The defaults are four-space indent, width 100 and a trailing comma:
rustfmt's. The Rust writer is one type, the core plus these methods. Generated Rust is held to
rustfmt under the `rustfmt.toml` every generated crate carries (`use_small_heuristics = "Max"`,
`short_array_element_width_threshold = 0`), so each rule below is rustfmt's under those
settings, and every `rust` case's expected output is a rustfmt fixed point under them.

- **`use_list(path, names)`** writes `use path::{a, b};` when it fits and `use path::a;` for one
  name. Otherwise it writes `use path::{`, fills the names onto lines one level in (each
  followed by a comma, as many to a line as fit) and `};`. Imports are not collected or
  sorted: a generator writes them in rustfmt's order (`std` and `crate` paths among the rest, in
  code-point order).
- **`doc(text)`** writes an author's text as `///` lines, one per line of the text, a bare `///`
  for an empty line, never re-wrapped. **`prose(text)`** writes text the generator composed:
  each line of the text is a paragraph, wrapped at a word boundary so no line passes the width.
  **`doc_break()`** writes the bare `///` between two paragraphs.
- **`assign(head, rhs)`** writes `head rhs` when it fits. Otherwise, when the right-hand side
  fits alone on the next line one level in, it writes the head and then the right-hand side
  there, an array as well as a call. Otherwise it keeps the right-hand side on the head's line
  and breaks its last list.

## Extension by subclassing

A writer and the generators built on it are meant to be extended in place
([ADR-0063](decisions/ADR-0063-generators-own-layout.md), item 7):

- A writer class is not final. Every method is public or protected, never private, so a
  subclass can override one step and keep the rest. In TypeScript the core's steps include
  `piece` (what a part becomes), `breakAt` (where a line that does not fit breaks) and `fits`.
  `TsWriter` adds `writeHeader`, `writeImports`, `writeImport` and `orderModules`. `JavaWriter`
  and `KotlinWriter` add `writeHeader`, `writePackage`, `writeImports` and `needsImport`.
- A reference generator is a class whose output comes from one overridable method per
  meaningful piece: the file header, the imports, and each section or member. An adopter
  overrides the method for the piece it wants changed, and passes its subclass where the
  reference generator was configured.
- Overridable methods are not a stability contract. They may change between minor versions.
  The conformance cases pin the output of the methods as shipped, not their names.

## Fixture format

Each case in `fixtures/writer-conformance/cases/` is one JSON file:

```jsonc
{
  "description": "What the case pins, in one sentence.",
  "dialect": "core",                       // or a language: "typescript"
  "options": { "indent": "  ", "width": 40, "trailingComma": true },   // required for core
  "ops": [
    ["open", "class A {"],
    ["line", "f", { "list": { "open": "(", "items": ["a", "b"], "close": ")" } }, ";"],
    ["blank"],
    ["text", "fixed\ncode"],
    ["close", "}"]
  ],
  "expected": ["class A {", "  f(a, b);", "  fixed", "  code", "}"]
}
```

- An op is an array: its name, then its arguments. The core ops are `line`, `open` and `close`
  (whose arguments are parts), `blank` and `text`. The TypeScript ops are `use`, `useType`,
  `useDefault`, `useNamespace` and `useSideEffect` (name, then module; `useSideEffect` takes
  only the module), `header` and `doc` (lines). The Python ops are `use` (name, module), `useAs` (name, module,
  alias), `useModule` (module, optional alias), `useFuture` (optional name), `header` and `doc`
  (lines), `dedent` and `gap`. The Kotlin ops are `package` (name), `use` (name), `useAs` (name,
  alias), `header` and `doc` (lines), and `reopen` (parts). The Rust ops are `use` (path, then names), `doc` and `prose`
  (text), `docBreak` and `assign` (head, then parts).
- A part is a string, a list (`{"list": {"open", "items", "close", "pad"?}}`, where items are
  parts) or an array of parts, which are concatenated.
- `expected` is the output's lines. The file is those lines joined with `\n` plus a final `\n`,
  or the empty string when the array is empty.
- A case that must fail has `"error"` (the error code) in place of `expected`. It may also have
  `"errorQuotes"`, text the error message must contain.
