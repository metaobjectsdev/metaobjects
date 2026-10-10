// FR-044 Plan 4, Task 4 — the YAML text of one cube (Table H is the contract, byte for byte).
//
// A hand-written emitter for exactly the shapes a CubeSpec holds, because the bytes are a golden
// and a YAML library's quoting choices would move them: block lists for `joins`, `dimensions`,
// `measures`, `segments`, `pre_aggregations`, `filters` and `time_dimensions`; flow lists for a
// rollup's `measures`, `dimensions` and `segments` and for `meta.grains`. Two-space indent, LF
// line endings, one trailing newline, no trailing spaces, no blank lines.
//
// Three kinds of scalar (Table G, YAML row):
//   - SQL (`sql_table`, `sql`, a join's or a filter's `sql`) arrives already escaped for Cube's
//     template reader (backslashes doubled, `{...}` escaped) and for Jinja (cube-sql.ts), so it is
//     only quoted for YAML: single-quoted (`'` doubled) when it is plain text, as Table H shows. A
//     single-quoted scalar folds a line break and cannot hold a control character, and a string
//     `@filter` value is legal model data, so a value holding a control character, a line
//     separator or a byte-order mark is written double-quoted (JSON escapes) instead. Nothing is
//     refused and nothing is altered.
//   - Free text (`title`, `description`) arrives raw, and Cube reads it as a template too (executed
//     on Cube 1.7.43): `{x}` is a member reference, `${x}` an interpolation and a backslash
//     an escape, so `a {b} c` fails the whole model and `C:\path` comes back `C:path`. The text is
//     encoded for that first: every `\` doubled, then `{` → `\{` and `}` → `\}`. Cube runs Jinja over
//     the whole file, so text whose ORIGINAL form holds `{{`, `{%` or `{#` is then wrapped in
//     `{% raw %}...{% endraw %}` (an escaped `\{%` still holds `{%`). The result is written as a JSON
//     string (a valid YAML double-quoted scalar, so each of those backslashes is doubled again in
//     the file). Cube's `/v1/meta` hands back the text exactly as the model declares it.
//   - Names, types, booleans, relationships, granularities and `CUBE.<member>` references are plain,
//     except a name a YAML reader would take for a boolean or null (true, false, null, yes, no, on,
//     off, y, n, in any case), which is single-quoted so it stays a string.

import { GENERATED_HEADER } from "../constants.js";
import { CubeModelError, ERR_CUBE_UNESCAPABLE_LITERAL } from "./cube-errors.js";
import type {
  CubeDimensionSpec,
  CubeJoinSpec,
  CubeMeasureSpec,
  CubeRollupSpec,
  CubeSegmentSpec,
  CubeSpec,
} from "./cube-model-spec.js";
import { escapeCubeTemplate, jinjaSafe, JINJA_RAW_END } from "./cube-template.js";

const INDENT = "  ";

/** A mapping or a list item as lines, relative to its own indent. */
type Lines = string[];

/** The text after the header, naming the generator that wrote the file. */
const HEADER_NOTE = "cube-model";

/** A member reference inside a rollup: the member on the cube the rollup belongs to. */
function cubeRef(member: string): string {
  return `CUBE.${member}`;
}

/** A name is plain unless a YAML reader would take the word for a boolean or null. */
const YAML_NON_STRING_WORD = /^(?:true|false|null|yes|no|on|off|y|n)$/i;

function nameScalar(name: string): string {
  return YAML_NON_STRING_WORD.test(name) ? singleQuoted(name) : name;
}

function singleQuoted(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Characters a single-quoted YAML scalar cannot carry intact or a YAML reader may take for a line
 * break: the C0 controls (line breaks and tab included), DEL and the C1 controls, the line and
 * paragraph separators and the byte-order mark.
 */
const NOT_SINGLE_QUOTABLE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufeff]/;

/** The same set, where it has to be written as a \u escape because JSON.stringify leaves it raw. */
const ESCAPED_IN_JSON = /[\u007f-\u009f\u2028\u2029\ufeff]/g;

/** `text` as a YAML double-quoted scalar: a JSON string, with the characters JSON leaves raw escaped. */
function doubleQuoted(text: string): string {
  return JSON.stringify(text).replace(ESCAPED_IN_JSON, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** A SQL value as a YAML scalar: single-quoted, or double-quoted when it holds a character that cannot be. */
function sqlScalar(sql: string): string {
  return NOT_SINGLE_QUOTABLE.test(sql) ? doubleQuoted(sql) : singleQuoted(sql);
}

/**
 * Free text as a double-quoted scalar that Cube hands back unchanged: Cube-template escaped, then
 * Jinja-wrapped when the original holds an opener (cube-template.ts, the rule SQL follows too).
 * `where` names its place for the refusal.
 */
function textScalar(text: string, where: string): string {
  const safe = jinjaSafe(text, escapeCubeTemplate(text), () =>
    new CubeModelError(
      ERR_CUBE_UNESCAPABLE_LITERAL,
      `${where}: the text ${JSON.stringify(text)} contains "${JINJA_RAW_END}", which would end the {% raw %} block ` +
        `that keeps Jinja away from it, so Cube cannot be given it intact. Reword it in the model.`,
    ),
  );
  return doubleQuoted(safe);
}

function indented(lines: Lines): Lines {
  return lines.map((line) => `${INDENT}${line}`);
}

/** One block-list entry: the first line carries the dash, the rest align under it. */
function listItem(lines: Lines): Lines {
  return lines.map((line, i) => (i === 0 ? "- " : INDENT) + line);
}

/** `key:` and its block-list entries, or nothing for an empty list. */
function blockList(key: string, items: readonly Lines[]): Lines {
  if (items.length === 0) return [];
  return [`${key}:`, ...indented(items.flatMap(listItem))];
}

/** `key: [a, b]`, or nothing for an empty list. */
function flowList(key: string, values: readonly string[]): Lines {
  return values.length === 0 ? [] : [`${key}: [${values.join(", ")}]`];
}

/** The keys every cube and member shares, in Table H's order: `public`, `title`, `description`. */
function documentation(node: { public?: boolean; title?: string; description?: string }, at: string): Lines {
  const out: Lines = [];
  if (node.public !== undefined) out.push(`public: ${node.public}`);
  if (node.title !== undefined) out.push(`title: ${textScalar(node.title, `${at} title`)}`);
  if (node.description !== undefined) out.push(`description: ${textScalar(node.description, `${at} description`)}`);
  return out;
}

function renderJoin(join: CubeJoinSpec): Lines {
  return [`name: ${nameScalar(join.name)}`, `relationship: ${join.relationship}`, `sql: ${sqlScalar(join.sql)}`];
}

function renderDimension(dimension: CubeDimensionSpec, cube: string): Lines {
  const at = `cube '${cube}' dimension '${dimension.name}'`;
  const out: Lines = [
    `name: ${nameScalar(dimension.name)}`,
    `sql: ${sqlScalar(dimension.sql)}`,
    `type: ${dimension.type}`,
  ];
  if (dimension.primaryKey !== undefined) out.push(`primary_key: ${dimension.primaryKey}`);
  out.push(...documentation(dimension, at));
  if (dimension.meta !== undefined && dimension.meta.grains.length > 0) {
    out.push("meta:", ...indented(flowList("grains", dimension.meta.grains)));
  }
  return out;
}

function renderMeasure(measure: CubeMeasureSpec, cube: string): Lines {
  const at = `cube '${cube}' measure '${measure.name}'`;
  const filters = (measure.filters ?? []).map((f): Lines => [`sql: ${sqlScalar(f.sql)}`]);
  return [
    `name: ${nameScalar(measure.name)}`,
    `sql: ${sqlScalar(measure.sql)}`,
    `type: ${measure.type}`,
    ...blockList("filters", filters),
    ...documentation(measure, at),
  ];
}

function renderSegment(segment: CubeSegmentSpec, cube: string): Lines {
  const at = `cube '${cube}' segment '${segment.name}'`;
  return [
    `name: ${nameScalar(segment.name)}`,
    `sql: ${sqlScalar(segment.sql)}`,
    ...documentation(segment, at),
  ];
}

function renderRollup(rollup: CubeRollupSpec): Lines {
  const out: Lines = [
    `name: ${nameScalar(rollup.name)}`,
    `type: ${rollup.type}`,
    ...flowList("measures", rollup.measures.map(cubeRef)),
    ...flowList("dimensions", rollup.dimensions.map(cubeRef)),
    ...flowList("segments", rollup.segments.map(cubeRef)),
  ];
  if (rollup.timeDimensions !== undefined) {
    const entries = rollup.timeDimensions.map(
      (t): Lines => [`dimension: ${cubeRef(t.dimension)}`, `granularity: ${t.granularity}`],
    );
    out.push(...blockList("time_dimensions", entries));
  } else if (rollup.timeDimension !== undefined) {
    out.push(`time_dimension: ${cubeRef(rollup.timeDimension)}`, `granularity: ${rollup.granularity}`);
  }
  return out;
}

function renderCube(cube: CubeSpec): Lines {
  const at = `cube '${cube.name}'`;
  const out: Lines = [`name: ${nameScalar(cube.name)}`];
  if (cube.sqlTable !== undefined) out.push(`sql_table: ${sqlScalar(cube.sqlTable)}`);
  if (cube.sql !== undefined) out.push(`sql: ${sqlScalar(cube.sql)}`);
  out.push(
    ...documentation(cube, at),
    ...blockList("joins", cube.joins.map(renderJoin)),
    ...blockList("dimensions", cube.dimensions.map((d) => renderDimension(d, cube.name))),
    ...blockList("measures", cube.measures.map((m) => renderMeasure(m, cube.name))),
    ...blockList("segments", cube.segments.map((s) => renderSegment(s, cube.name))),
    ...blockList("pre_aggregations", cube.preAggregations.map(renderRollup)),
  );
  return out;
}

/**
 * The YAML file for one cube, as `model/cubes/<name>.yml` holds it. Throws `CubeModelError`
 * (`ERR_CUBE_UNESCAPABLE_LITERAL`, naming the cube and member) for free text that is raw-wrapped
 * (it holds a Jinja opener) and holds `endraw`.
 */
export function renderCubeYaml(cube: CubeSpec): string {
  const lines = [`# ${GENERATED_HEADER} — ${HEADER_NOTE}`, "cubes:", ...indented(listItem(renderCube(cube)))];
  return `${lines.join("\n")}\n`;
}
