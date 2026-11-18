// The layout ratchet's analyzer (ADR-0063): finds layout a generator typed by hand.
//
// Generators say what a line contains and the writer decides where it sits, so generator
// source should never spell a line break or an indentation run. This reads a source file
// with the TypeScript compiler's parser (`ts.createSourceFile`) and walks the syntax tree.
// Working on the tree, not the text, is what makes the rules exact:
//
//   - comments are never nodes, so a comment is never a finding;
//   - a string's value is the parser's cooked value, so `"\n"`, `"\x0a"` and a literal line
//     break inside a template are the same finding;
//   - a constant is followed to its declaration, so `const NL = "\n"; xs.join(NL)` is a
//     finding at the join as well as at the declaration.
//
// Four rules:
//
//   newline-literal  a string or template literal part whose value contains a line break.
//   indent-literal   a string or template literal that starts a line of output (a whole
//                    string, or the head of a template) and begins with an indentation run:
//                    two or more spaces, or a tab.
//   newline-join     `xs.join(sep)` or `joinCode(xs, { on: sep })` whose separator contains a
//                    line break, the separator resolved through same-file constants.
//   indent-repeat    `s.repeat(n)` where `s` resolves to whitespace: building indentation.
//
// Two places a literal is not output, and so is not layout, are ruled out by position:
//
//   - a search pattern: the first argument of split, indexOf, lastIndexOf, includes,
//     startsWith, endsWith, replace or replaceAll (the text being looked for, not written);
//   - a writer snippet: the argument of a `.text(...)` call, the writer's entry for fixed
//     code written as it should read (it removes the margin and re-indents).
//
// Type positions (`type Sep = "\n"`) and module specifiers are not values and are skipped.

import ts from "typescript";

export type FindingKind = "newline-literal" | "indent-literal" | "newline-join" | "indent-repeat";

export interface Finding {
  readonly kind: FindingKind;
  /** 1-based line and column of the node in the source. */
  readonly line: number;
  readonly column: number;
  /** The source text of the offending node, shortened. */
  readonly excerpt: string;
}

const LINE_BREAK = /[\r\n]/;
const INDENT_RUN = /^(?: {2,}|\t)/;
const WHITESPACE = /^[ \t\r\n]+$/;
const SEARCH_METHODS = new Set(["split", "indexOf", "lastIndexOf", "includes", "startsWith", "endsWith", "replace", "replaceAll"]);
const SNIPPET_METHOD = "text";
const JOIN_METHOD = "join";
const JOIN_CODE = "joinCode";
const JOIN_CODE_SEPARATOR = "on";
const REPEAT_METHOD = "repeat";
const MAX_RESOLVE_DEPTH = 8;

/** What a string expression is known to contain. `complete` is false when part of it is unknown. */
interface Resolved {
  readonly text: string;
  readonly complete: boolean;
}

export function analyzeSource(fileName: string, source: string): Finding[] {
  const kind = fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, kind);
  const consts = collectConsts(sf);
  const findings: Finding[] = [];

  const report = (k: FindingKind, node: ts.Node): void => {
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    const raw = node.getText(sf).replace(/\s+/g, " ");
    findings.push({ kind: k, line: line + 1, column: character + 1, excerpt: raw.length > 60 ? `${raw.slice(0, 57)}...` : raw });
  };

  const resolve = (expr: ts.Expression, depth = 0): Resolved | undefined => {
    if (depth > MAX_RESOLVE_DEPTH) return undefined;
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return { text: expr.text, complete: true };
    if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isSatisfiesExpression(expr) || ts.isNonNullExpression(expr) || ts.isTypeAssertionExpression(expr)) {
      return resolve(expr.expression, depth + 1);
    }
    if (ts.isBinaryExpression(expr) && expr.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = resolve(expr.left, depth + 1);
      const r = resolve(expr.right, depth + 1);
      if (l === undefined && r === undefined) return undefined;
      return { text: (l?.text ?? "") + (r?.text ?? ""), complete: l?.complete === true && r?.complete === true };
    }
    if (ts.isTemplateExpression(expr)) {
      let text = expr.head.text;
      let complete = true;
      for (const span of expr.templateSpans) {
        const sub = resolve(span.expression, depth + 1);
        text += (sub?.text ?? "") + span.literal.text;
        complete &&= sub?.complete === true;
      }
      return { text, complete };
    }
    if (ts.isConditionalExpression(expr)) {
      // Either branch may be written; for "does it contain a line break" both count.
      const a = resolve(expr.whenTrue, depth + 1);
      const b = resolve(expr.whenFalse, depth + 1);
      if (a === undefined && b === undefined) return undefined;
      return { text: (a?.text ?? "") + (b?.text ?? ""), complete: false };
    }
    if (ts.isIdentifier(expr)) {
      const init = consts.get(expr.text);
      return init === undefined ? undefined : resolve(init, depth + 1);
    }
    if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
      const obj = consts.get(expr.expression.text);
      const target = obj === undefined ? undefined : unwrap(obj);
      if (target !== undefined && ts.isObjectLiteralExpression(target)) {
        const prop = findProperty(target, expr.name.text);
        return prop === undefined ? undefined : resolve(prop, depth + 1);
      }
    }
    return undefined;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTypeNode(node) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExternalModuleReference(node)) return;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      checkLiteral(node);
    } else if (ts.isCallExpression(node)) {
      checkCall(node);
    }
    ts.forEachChild(node, visit);
  };

  const checkLiteral = (lit: ts.StringLiteral | ts.NoSubstitutionTemplateLiteral | ts.TemplateLiteralLikeNode): void => {
    const whole = literalExpression(lit);
    if (isSearchPattern(whole) || isSnippet(whole)) return;
    const value = lit.text;
    if (LINE_BREAK.test(value)) report("newline-literal", lit);
    else if (startsALine(lit) && INDENT_RUN.test(value)) report("indent-literal", lit);
  };

  const checkCall = (call: ts.CallExpression): void => {
    const method = calledName(call);
    if (method === JOIN_METHOD && ts.isPropertyAccessExpression(call.expression) && call.arguments.length > 0) {
      const sep = resolve(call.arguments[0]!);
      if (sep !== undefined && LINE_BREAK.test(sep.text)) report("newline-join", call);
    } else if (method === JOIN_CODE && call.arguments.length > 1) {
      const opts = unwrap(call.arguments[1]!);
      const on = opts !== undefined && ts.isObjectLiteralExpression(opts) ? findProperty(opts, JOIN_CODE_SEPARATOR) : undefined;
      const sep = on === undefined ? undefined : resolve(on);
      if (sep !== undefined && LINE_BREAK.test(sep.text)) report("newline-join", call);
    } else if (method === REPEAT_METHOD && ts.isPropertyAccessExpression(call.expression)) {
      const unit = resolve(call.expression.expression);
      if (unit !== undefined && unit.complete && WHITESPACE.test(unit.text)) report("indent-repeat", call);
    }
  };

  visit(sf);
  return findings;
}

/** Every `const name = <expr>` in the file. A name declared more than once is left out: it is shadowed somewhere. */
function collectConsts(sf: ts.SourceFile): Map<string, ts.Expression> {
  const seen = new Map<string, ts.Expression | null>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      const list = node.parent;
      const isConst = ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0;
      const name = node.name.text;
      seen.set(name, seen.has(name) || !isConst || node.initializer === undefined ? null : node.initializer);
    } else if ((ts.isParameter(node) || ts.isBindingElement(node)) && ts.isIdentifier(node.name)) {
      // A parameter or destructured name shadows any constant of the same name.
      seen.set(node.name.text, null);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  const out = new Map<string, ts.Expression>();
  for (const [name, init] of seen) if (init !== null) out.set(name, init);
  return out;
}

function unwrap(expr: ts.Expression): ts.Expression | undefined {
  let e: ts.Expression = expr;
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
  return e;
}

function findProperty(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer;
  }
  return undefined;
}

/** The method or function name a call invokes: `x.join(...)` is "join", `joinCode(...)` is "joinCode". */
function calledName(call: ts.CallExpression): string | undefined {
  const callee = call.expression;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  if (ts.isIdentifier(callee)) return callee.text;
  return undefined;
}

/** The whole expression a literal part belongs to: the literal itself, or its template. */
function literalExpression(lit: ts.Node): ts.Node {
  if (ts.isTemplateHead(lit)) return lit.parent;
  if (ts.isTemplateMiddle(lit) || ts.isTemplateTail(lit)) return lit.parent.parent;
  return lit;
}

/** A string or template head starts its own text; a middle or tail follows a substitution. */
function startsALine(lit: ts.Node): boolean {
  return !(ts.isTemplateMiddle(lit) || ts.isTemplateTail(lit));
}

function isArgument(expr: ts.Node, method: (name: string) => boolean, index: number): boolean {
  const call = expr.parent;
  if (call === undefined || !ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return false;
  return method(call.expression.name.text) && call.arguments[index] === expr;
}

function isSearchPattern(expr: ts.Node): boolean {
  return isArgument(expr, (n) => SEARCH_METHODS.has(n), 0);
}

function isSnippet(expr: ts.Node): boolean {
  return isArgument(expr, (n) => n === SNIPPET_METHOD, 0);
}

// ── which files the ratchet reads ────────────────────────────────────────────────────────

/** The packages whose `src/` holds TypeScript generator source, relative to `server/typescript/packages/`. */
export const SCANNED_PACKAGES = ["codegen-ts", "codegen-ts-react", "codegen-ts-tanstack", "codegen-ts-angular"] as const;

/** The writer itself: the one module family that lays text out, so the one allowed to type layout. */
const WRITER_DIR = "codegen-ts/src/writer/";

/**
 * Whether a file (relative to `server/typescript/packages/`) is generator source the ratchet
 * reads. Excluded by rule, never by listing: anything outside a scanned package's `src/`,
 * tests, declaration files, the writer, and files a build script generated (`*.generated.ts`,
 * which hold data such as embedded template bodies and are rewritten by that script).
 */
export function isGeneratorSource(rel: string): boolean {
  const path = rel.replaceAll("\\", "/");
  if (!SCANNED_PACKAGES.some((p) => path.startsWith(`${p}/src/`))) return false;
  if (!/\.tsx?$/.test(path) || path.endsWith(".d.ts")) return false;
  if (/(?:^|\/)(?:test|tests|__tests__)\//.test(path) || /\.(?:test|spec)\.tsx?$/.test(path)) return false;
  if (path.startsWith(WRITER_DIR)) return false;
  if (/\.generated\.tsx?$/.test(path)) return false;
  return true;
}
