// FR-044 Plan 4, Task 4 — the YAML text of one cube, and of one Cube view (Table H is the contract,
// byte for byte).
//
// A hand-written emitter for exactly the shapes a CubeSpec and a CubeViewSpec hold, because the
// bytes are a golden and a YAML library's quoting choices would move them: block lists for
// `joins`, `dimensions`, `measures`, `segments`, `pre_aggregations`, `filters`, `time_dimensions`,
// a view's `cubes` and their `includes`; flow lists for a rollup's `measures`, `dimensions` and
// `segments` and for `meta.grains`. Two-space indent, LF
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
//   - Names, types, booleans, relationships, granularities, join paths and `CUBE.<member>` references are plain,
//     except a name a YAML reader would take for a boolean or null (true, false, null, yes, no, on,
//     off, y, n, in any case), which is single-quoted so it stays a string.

import { GENERATED_HEADER } from "../constants.js";
import { CubeModelError, ERR_CUBE_UNESCAPABLE_LITERAL } from "./cube-errors.js";
import {
  CUBE_MODEL_GENERATOR_NAME,
  type CubeDimensionMeta,
  type CubeDimensionSpec,
  type CubeJoinSpec,
  type CubeMeasureSpec,
  type CubeRollupSpec,
  type CubeSegmentSpec,
  type CubeSpec,
  type CubeViewCubeSpec,
  type CubeViewIncludeSpec,
  type CubeViewSpec,
} from "./cube-model-spec.js";
import { escapeCubeTemplate, jinjaSafe, JINJA_RAW_END } from "./cube-template.js";
import { YamlWriter } from "../writer/yaml-writer.js";

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

/** `key:` and one block-list entry per item, or nothing for an empty list. */
function blockList<T>(w: YamlWriter, key: string, items: readonly T[], write: (item: T) => void): void {
  if (items.length === 0) return;
  w.key(key, () => {
    for (const item of items) w.item(() => write(item));
  });
}

/** `key: [a, b]`, or nothing for an empty list. */
function flowList(w: YamlWriter, key: string, values: readonly string[]): void {
  if (values.length > 0) w.line(`${key}: [${values.join(", ")}]`);
}

/** The keys every cube and member shares, in Table H's order: `public`, `title`, `description`. */
function writeDocumentation(w: YamlWriter, node: { public?: boolean; title?: string; description?: string }, at: string): void {
  if (node.public !== undefined) w.line(`public: ${node.public}`);
  if (node.title !== undefined) w.line(`title: ${textScalar(node.title, `${at} title`)}`);
  if (node.description !== undefined) w.line(`description: ${textScalar(node.description, `${at} description`)}`);
}

function writeJoin(w: YamlWriter, join: CubeJoinSpec): void {
  w.line(`name: ${nameScalar(join.name)}`);
  w.line(`relationship: ${join.relationship}`);
  w.line(`sql: ${sqlScalar(join.sql)}`);
}

function writeDimension(w: YamlWriter, dimension: CubeDimensionSpec, cube: string): void {
  const at = `cube '${cube}' dimension '${dimension.name}'`;
  w.line(`name: ${nameScalar(dimension.name)}`);
  w.line(`sql: ${sqlScalar(dimension.sql)}`);
  w.line(`type: ${dimension.type}`);
  if (dimension.primaryKey !== undefined) w.line(`primary_key: ${dimension.primaryKey}`);
  writeDocumentation(w, dimension, at);
  writeGrains(w, dimension.meta);
}

/** The `meta:` block, present only when the member carries grains (empty grains emit nothing). */
function writeGrains(w: YamlWriter, meta: CubeDimensionMeta | undefined): void {
  if (meta === undefined || meta.grains.length === 0) return;
  w.key("meta", () => flowList(w, "grains", meta.grains));
}

function writeMeasure(w: YamlWriter, measure: CubeMeasureSpec, cube: string): void {
  const at = `cube '${cube}' measure '${measure.name}'`;
  w.line(`name: ${nameScalar(measure.name)}`);
  w.line(`sql: ${sqlScalar(measure.sql)}`);
  w.line(`type: ${measure.type}`);
  blockList(w, "filters", measure.filters ?? [], (f) => w.line(`sql: ${sqlScalar(f.sql)}`));
  writeDocumentation(w, measure, at);
}

function writeSegment(w: YamlWriter, segment: CubeSegmentSpec, cube: string): void {
  const at = `cube '${cube}' segment '${segment.name}'`;
  w.line(`name: ${nameScalar(segment.name)}`);
  w.line(`sql: ${sqlScalar(segment.sql)}`);
  writeDocumentation(w, segment, at);
}

function writeRollup(w: YamlWriter, rollup: CubeRollupSpec): void {
  w.line(`name: ${nameScalar(rollup.name)}`);
  w.line(`type: ${rollup.type}`);
  flowList(w, "measures", rollup.measures.map(cubeRef));
  flowList(w, "dimensions", rollup.dimensions.map(cubeRef));
  flowList(w, "segments", rollup.segments.map(cubeRef));
  if (rollup.timeDimensions !== undefined) {
    blockList(w, "time_dimensions", rollup.timeDimensions, (t) => {
      w.line(`dimension: ${cubeRef(t.dimension)}`);
      w.line(`granularity: ${t.granularity}`);
    });
  } else if (rollup.timeDimension !== undefined) {
    w.line(`time_dimension: ${cubeRef(rollup.timeDimension)}`);
    w.line(`granularity: ${rollup.granularity}`);
  }
}

function writeCube(w: YamlWriter, cube: CubeSpec): void {
  const at = `cube '${cube.name}'`;
  w.line(`name: ${nameScalar(cube.name)}`);
  if (cube.sqlTable !== undefined) w.line(`sql_table: ${sqlScalar(cube.sqlTable)}`);
  if (cube.sql !== undefined) w.line(`sql: ${sqlScalar(cube.sql)}`);
  writeDocumentation(w, cube, at);
  blockList(w, "joins", cube.joins, (j) => writeJoin(w, j));
  blockList(w, "dimensions", cube.dimensions, (d) => writeDimension(w, d, cube.name));
  blockList(w, "measures", cube.measures, (m) => writeMeasure(w, m, cube.name));
  blockList(w, "segments", cube.segments, (sg) => writeSegment(w, sg, cube.name));
  blockList(w, "pre_aggregations", cube.preAggregations, (r) => writeRollup(w, r));
}

function writeViewInclude(w: YamlWriter, include: CubeViewIncludeSpec, view: string): void {
  const at = `view '${view}' member '${include.alias ?? include.name}'`;
  w.line(`name: ${nameScalar(include.name)}`);
  if (include.alias !== undefined) w.line(`alias: ${nameScalar(include.alias)}`);
  writeDocumentation(w, include, at);
  writeGrains(w, include.meta);
}

function writeViewCube(w: YamlWriter, entry: CubeViewCubeSpec, view: string): void {
  w.line(`join_path: ${nameScalar(entry.joinPath)}`);
  blockList(w, "includes", entry.includes, (include) => writeViewInclude(w, include, view));
}

/**
 * The YAML file for one Cube view, as `model/views/<name>.yml` holds it: the scalar rules of
 * {@link renderCubeYaml}. Throws `CubeModelError` (`ERR_CUBE_UNESCAPABLE_LITERAL`, naming the view
 * and member) for free text that is raw-wrapped and holds `endraw`.
 */
export function renderCubeViewYaml(view: CubeViewSpec): string {
  return writeFile("views", (w) => {
    w.line(`name: ${nameScalar(view.name)}`);
    writeDocumentation(w, view, `view '${view.name}'`);
    blockList(w, "cubes", view.cubes, (entry) => writeViewCube(w, entry, view.name));
  });
}

/**
 * The YAML file for one cube, as `model/cubes/<name>.yml` holds it. Throws `CubeModelError`
 * (`ERR_CUBE_UNESCAPABLE_LITERAL`, naming the cube and member) for free text that is raw-wrapped
 * (it holds a Jinja opener) and holds `endraw`.
 */
export function renderCubeYaml(cube: CubeSpec): string {
  return writeFile("cubes", (w) => writeCube(w, cube));
}

/** The framing both file kinds share: header line, one top-level key, its one entry. */
function writeFile(rootKey: string, item: (w: YamlWriter) => void): string {
  const w = new YamlWriter();
  w.line(`# ${GENERATED_HEADER} — ${CUBE_MODEL_GENERATOR_NAME}`);
  w.key(rootKey, () => w.item(() => item(w)));
  return w.toString();
}
