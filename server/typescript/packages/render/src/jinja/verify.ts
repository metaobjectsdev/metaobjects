// The Jinja half of the template drift check (ADR-0061). Same contract as the
// Mustache `verify`: every payload reference a template makes must exist on the
// declared payload field tree, or it is reported. It walks the PARSED nunjucks
// AST — never the text — and follows what Jinja code actually does:
//
//   {{ user.name }} / {{ user["name"] }}   a path into the payload, checked per segment
//   {% for p in posts %}{{ p.title }}      `posts` is checked, then `p.title` against
//                                          posts' element fields
//   {% set x = … %} / macro params         locals, not payload — never reported
//   {{ name | upper }}                     the argument is checked, the filter is not
//   {% if %} / {{ a if b else c }}         every operand is checked
//   {% include "x" %} / import / extends   resolved through the provider, walked
//
// A reference the check cannot settle without running the template — a dynamic key
// on an object, a computed template name — is ERR_TEMPLATE_NOT_STATIC: reported,
// never passed. The Python port (metaobjects/render/jinja_verify.py) walks the
// jinja2 AST to the same rules; both are held to fixtures/jinja-verify-conformance/.

import {
  ERR_VAR_NOT_ON_PAYLOAD,
  ERR_PARTIAL_UNRESOLVED,
  ERR_TEMPLATE_NOT_STATIC,
  ERR_TEMPLATE_SYNTAX,
  ERR_TEMPLATE_ENGINE_UNSUPPORTED,
  MAX_DEPTH,
  slotAndTagFindings,
  type PayloadField,
  type VerifyError,
  type VerifyOptions,
} from "../verify-shared.js";
import { TEMPLATE_ENGINE_JINJA, partialEngineMismatch } from "../engine.js";
import { childNodes, isNode, parseJinja, refOfTemplateName, type NjNode } from "./nunjucks.js";

/** A value whose shape the payload declares. `path` is the expression as written. */
interface Typed {
  readonly tag: "typed";
  readonly fields: PayloadField[] | undefined;
  readonly isArray: boolean;
  readonly path: string;
}
/** A local, a literal or a computed value: not payload, so nothing to check on it. */
interface Opaque {
  readonly tag: "opaque";
}
type Value = Typed | Opaque;
const OPAQUE: Opaque = { tag: "opaque" };

/**
 * Names a template may use without the payload declaring them: the engines' own
 * globals and the block helpers. Shared with the Python port, so a name is
 * accepted in one port exactly when it is accepted in the other.
 */
export const JINJA_GLOBALS: ReadonlySet<string> = new Set([
  "range", "cycler", "joiner", "namespace", "dict", "lipsum", "super", "self",
]);

/** Filters whose result is ONE element of their argument. */
const ELEMENT_FILTERS: ReadonlySet<string> = new Set(["first", "last", "random"]);
/** Filters whose result has the shape of their argument. */
const SAME_SHAPE_FILTERS: ReadonlySet<string> = new Set([
  "sort", "reverse", "list", "unique", "selectattr", "rejectattr", "default", "d",
]);
/**
 * Filters with a positional argument that names an element attribute, and its index
 * among the arguments after the subject (`join(", ", "name")`, `sort(false, false, "name")`).
 * The same positions in jinja2 and nunjucks; `min`, `max` and `unique` are jinja2's,
 * kept so the two ports' checks agree.
 */
const ATTRIBUTE_ARG_INDEX: ReadonlyMap<string, number> = new Map([
  ["selectattr", 0], ["rejectattr", 0], ["groupby", 0], ["sum", 0],
  ["join", 1], ["min", 1], ["max", 1], ["unique", 1], ["sort", 2],
]);
/** The keyword argument that names an element attribute (`map(attribute="x")`). */
const ATTRIBUTE_KWARG = "attribute";

interface Scope {
  /** Local frames, innermost last. */
  readonly frames: Map<string, Value>[];
  /** The payload fields reachable by bare name (empty for an import without context). */
  readonly root: PayloadField[];
  /** The include / import / extends chain that led here (cycle guard). */
  readonly seen: readonly string[];
}

/** A segment of a static member chain. */
type Segment =
  | { readonly kind: "key"; readonly key: string }
  | { readonly kind: "index"; readonly index: number }
  | { readonly kind: "dynamic"; readonly node: NjNode };

function typedOf(field: PayloadField, path: string): Typed {
  return { tag: "typed", fields: field.fields, isArray: field.isArray === true, path };
}

/** The element a `for` over `v` binds, named `path`. */
function elementOf(v: Value, path: string): Value {
  if (v.tag === "opaque") return OPAQUE;
  // An array iterates its elements; a non-array object iterates its keys (strings);
  // a scalar iterates its characters. Only the first has fields.
  return { tag: "typed", fields: v.isArray ? v.fields : undefined, isArray: false, path };
}

function segmentText(s: Segment): string {
  if (s.kind === "key") return `.${s.key}`;
  if (s.kind === "index") return `[${s.index}]`;
  return "[*]";
}

/**
 * Check a Jinja template against a payload field tree. Same options and codes as
 * `verify`; reached through `verify(text, fields, { engine: "jinja" })`.
 */
export function verifyJinja(
  templateText: string,
  fields: PayloadField[],
  opts?: VerifyOptions,
): VerifyError[] {
  const errors: VerifyError[] = [];
  const provider = opts?.provider;
  const referencedAtRoot = new Set<string>();
  const staticTexts: string[] = [templateText];
  const report = (code: string, path: string): void => {
    errors.push({ code, path });
  };

  function lookupName(name: string, scope: Scope): Value | undefined {
    for (let i = scope.frames.length - 1; i >= 0; i--) {
      const hit = scope.frames[i]!.get(name);
      if (hit !== undefined) return hit;
    }
    const field = scope.root.find((f) => f.name === name);
    if (field !== undefined) {
      if (scope.root === fields) referencedAtRoot.add(name);
      return typedOf(field, name);
    }
    return JINJA_GLOBALS.has(name) ? OPAQUE : undefined;
  }

  function bind(scope: Scope, name: string, value: Value): void {
    scope.frames[scope.frames.length - 1]!.set(name, value);
  }

  function pushFrame(scope: Scope): Scope {
    return { ...scope, frames: [...scope.frames, new Map()] };
  }

  /** Flatten `a.b[0][k]` into its base node and segments. */
  function chainOf(node: NjNode): { base: NjNode; segments: Segment[] } {
    const segments: Segment[] = [];
    let cur = node;
    while (cur.typename === "LookupVal") {
      const val = cur["val"] as NjNode;
      if (val.typename === "Literal" && typeof val["value"] === "string") {
        segments.unshift({ kind: "key", key: val["value"] });
      } else if (val.typename === "Literal" && typeof val["value"] === "number") {
        segments.unshift({ kind: "index", index: val["value"] });
      } else {
        segments.unshift({ kind: "dynamic", node: val });
      }
      cur = cur["target"] as NjNode;
    }
    return { base: cur, segments };
  }

  /** Evaluate a member chain: resolve the base, then descend one segment at a time. */
  function evalChain(node: NjNode, scope: Scope): Value {
    const { base, segments } = chainOf(node);
    for (const s of segments) if (s.kind === "dynamic") evalExpr(s.node, scope);
    let value: Value;
    let path: string;
    if (base.typename === "Symbol") {
      path = base["value"] as string;
      const fullPath = path + segments.map(segmentText).join("");
      const hit = lookupName(path, scope);
      if (hit === undefined) {
        report(ERR_VAR_NOT_ON_PAYLOAD, fullPath);
        return OPAQUE;
      }
      value = hit;
    } else {
      value = evalExpr(base, scope);
      path = value.tag === "typed" ? value.path : "";
    }
    const fullPath = path + segments.map(segmentText).join("");
    for (const s of segments) {
      if (value.tag === "opaque") return OPAQUE;
      path += segmentText(s);
      if (s.kind === "key") {
        const child = value.isArray ? undefined : value.fields?.find((f) => f.name === s.key);
        if (child === undefined) {
          report(ERR_VAR_NOT_ON_PAYLOAD, fullPath);
          return OPAQUE;
        }
        value = typedOf(child, path);
      } else if (value.isArray) {
        value = { tag: "typed", fields: value.fields, isArray: false, path };
      } else if (s.kind === "dynamic" && value.fields !== undefined) {
        // A computed key on an object: which field it reads is decided at render time.
        report(ERR_TEMPLATE_NOT_STATIC, fullPath);
        return OPAQUE;
      } else {
        // A literal index into an object, or any index into a string: an element or a
        // character, carrying the same fields (none, for a string).
        value = { tag: "typed", fields: value.fields, isArray: false, path };
      }
    }
    return value;
  }

  /** Check an `attribute` name (dotted) against the elements of `receiver`. */
  function checkAttributeName(receiver: Value, attrNode: NjNode, scope: Scope): void {
    if (receiver.tag === "opaque") {
      evalExpr(attrNode, scope);
      return;
    }
    if (attrNode.typename !== "Literal" || typeof attrNode["value"] !== "string") {
      evalExpr(attrNode, scope);
      report(ERR_TEMPLATE_NOT_STATIC, `${receiver.path}[*]`);
      return;
    }
    const attr = attrNode["value"];
    let current: PayloadField[] | undefined = receiver.fields;
    for (const seg of attr.split(".")) {
      const hit = current?.find((f) => f.name === seg);
      if (hit === undefined) {
        report(ERR_VAR_NOT_ON_PAYLOAD, `${receiver.path}.${attr}`);
        return;
      }
      current = hit.fields;
    }
  }

  /** Split a call/filter argument list into positional args and keyword pairs. */
  function splitArgs(args: NjNode | undefined): { positional: NjNode[]; keywords: [string, NjNode][] } {
    const positional: NjNode[] = [];
    const keywords: [string, NjNode][] = [];
    for (const a of args === undefined ? [] : childNodes(args)) {
      if (a.typename === "KeywordArgs") {
        for (const pair of childNodes(a)) {
          const key = pair["key"] as NjNode;
          keywords.push([String(key["value"]), pair["value"] as NjNode]);
        }
      } else {
        positional.push(a);
      }
    }
    return { positional, keywords };
  }

  function evalFilter(node: NjNode, scope: Scope): Value {
    const name = String((node["name"] as NjNode)["value"]);
    const { positional, keywords } = splitArgs(node["args"] as NjNode);
    const [subject, ...rest] = positional;
    const receiver = subject === undefined ? OPAQUE : evalExpr(subject, scope);
    rest.forEach((a, i) => {
      if (i === ATTRIBUTE_ARG_INDEX.get(name)) checkAttributeName(receiver, a, scope);
      else evalExpr(a, scope);
    });
    for (const [key, value] of keywords) {
      if (key === ATTRIBUTE_KWARG) checkAttributeName(receiver, value, scope);
      else evalExpr(value, scope);
    }
    if (ELEMENT_FILTERS.has(name)) {
      return receiver.tag === "typed" ? elementOf(receiver, `${receiver.path}|${name}`) : OPAQUE;
    }
    if (SAME_SHAPE_FILTERS.has(name)) return receiver;
    return OPAQUE;
  }

  function evalCall(node: NjNode, scope: Scope): Value {
    const callee = node["name"] as NjNode;
    if (callee.typename === "LookupVal") {
      // A method call (`user.items()`, `name.upper()`): the receiver is a payload path
      // and is checked; the method belongs to the value, not to the payload.
      evalExpr(callee["target"] as NjNode, scope);
    } else if (callee.typename === "Symbol") {
      const name = callee["value"] as string;
      if (lookupName(name, scope) === undefined) report(ERR_VAR_NOT_ON_PAYLOAD, name);
    } else {
      evalExpr(callee, scope);
    }
    const { positional, keywords } = splitArgs(node["args"] as NjNode);
    positional.forEach((a) => evalExpr(a, scope));
    keywords.forEach(([, v]) => evalExpr(v, scope));
    return OPAQUE;
  }

  /** Walk a macro / `{% call %}` body: its parameters are locals in a frame of their own. */
  function walkCallable(node: NjNode, scope: Scope): void {
    const inner = pushFrame(scope);
    for (const local of ["caller", "varargs", "kwargs"]) bind(inner, local, OPAQUE);
    for (const arg of childNodes(node["args"] as NjNode)) {
      if (arg.typename === "Symbol") bind(inner, arg["value"] as string, OPAQUE);
      else if (arg.typename === "KeywordArgs") {
        for (const pair of childNodes(arg)) {
          evalExpr(pair["value"] as NjNode, scope); // a default is evaluated where it is declared
          bind(inner, String((pair["key"] as NjNode)["value"]), OPAQUE);
        }
      }
    }
    walk(node["body"] as NjNode, inner);
  }

  /** Resolve `{% include / import / extends %}`'s template and walk it in `scope`. */
  function followTemplate(
    keyword: string,
    templateNode: NjNode,
    scope: Scope,
    into: (scope: Scope, ref: string) => Scope,
    ignoreMissing = false,
  ): void {
    if (templateNode.typename !== "Literal" || typeof templateNode["value"] !== "string") {
      evalExpr(templateNode, scope);
      report(ERR_TEMPLATE_NOT_STATIC, keyword);
      return;
    }
    if (provider === undefined) return; // can't resolve without a provider
    const ref = refOfTemplateName(templateNode["value"]);
    if (scope.seen.includes(ref) || scope.seen.length >= MAX_DEPTH) return; // cycle/depth guard
    const text = provider.resolve(ref);
    if (text === undefined) {
      if (!ignoreMissing) report(ERR_PARTIAL_UNRESOLVED, ref);
      return;
    }
    if (partialEngineMismatch(provider, ref, TEMPLATE_ENGINE_JINJA)) {
      report(ERR_TEMPLATE_ENGINE_UNSUPPORTED, ref);
      return;
    }
    staticTexts.push(text);
    let ast: NjNode;
    try {
      ast = parseJinja(text);
    } catch (e) {
      report(ERR_TEMPLATE_SYNTAX, `${ref}: ${(e as Error).message}`);
      return;
    }
    walk(ast, into(scope, ref));
  }

  /** Bind a `for` / `set` target: a name, or a tuple of names (each opaque). */
  function bindTarget(target: NjNode, value: Value, scope: Scope): void {
    if (target.typename === "Symbol") bind(scope, target["value"] as string, value);
    else for (const t of childNodes(target)) bindTarget(t, OPAQUE, scope);
  }

  function evalExpr(node: NjNode, scope: Scope): Value {
    switch (node.typename) {
      case "Symbol":
      case "LookupVal":
        return evalChain(node, scope);
      case "Literal":
      case "TemplateData":
        return OPAQUE;
      case "Group": {
        const kids = childNodes(node);
        if (kids.length === 1) return evalExpr(kids[0]!, scope);
        kids.forEach((k) => evalExpr(k, scope));
        return OPAQUE;
      }
      case "Filter":
      case "FilterAsync":
        return evalFilter(node, scope);
      case "FunCall":
        return evalCall(node, scope);
      case "Caller":
        walkCallable(node, scope);
        return OPAQUE;
      case "Is": {
        // `x is defined` / `x is divisibleby(3)`: the subject is checked, the test is not.
        evalExpr(node["left"] as NjNode, scope);
        const test = node["right"] as NjNode;
        if (test.typename === "FunCall") {
          const { positional, keywords } = splitArgs(test["args"] as NjNode);
          positional.forEach((a) => evalExpr(a, scope));
          keywords.forEach(([, v]) => evalExpr(v, scope));
        }
        return OPAQUE;
      }
      case "Pair": {
        // A dict literal entry: a bare-name key is the key's own spelling, not a lookup.
        const key = node["key"] as NjNode;
        if (key.typename !== "Symbol") evalExpr(key, scope);
        evalExpr(node["value"] as NjNode, scope);
        return OPAQUE;
      }
      case "Capture":
        walk(node["body"] as NjNode, scope);
        return OPAQUE;
      default:
        // Operators, literals with children, inline-if, comparisons: check every operand.
        for (const child of childNodes(node)) evalExpr(child, scope);
        return OPAQUE;
    }
  }

  function walk(node: NjNode, scope: Scope): void {
    switch (node.typename) {
      case "Root":
      case "NodeList":
        for (const child of childNodes(node)) walk(child, scope);
        return;
      case "Output":
        for (const child of childNodes(node)) evalExpr(child, scope);
        return;
      case "If":
      case "IfAsync": {
        evalExpr(node["cond"] as NjNode, scope);
        // An `if` opens no scope: a `set` inside it is visible after it, as in Jinja.
        walk(node["body"] as NjNode, scope);
        if (isNode(node["else_"])) walk(node["else_"], scope);
        return;
      }
      case "For":
      case "AsyncEach":
      case "AsyncAll": {
        const iterable = evalExpr(node["arr"] as NjNode, scope);
        const inner = pushFrame(scope);
        bind(inner, "loop", OPAQUE);
        const target = node["name"] as NjNode;
        if (target.typename === "Symbol") {
          const name = target["value"] as string;
          bind(inner, name, elementOf(iterable, name));
        } else {
          bindTarget(target, OPAQUE, inner);
        }
        walk(node["body"] as NjNode, inner);
        if (isNode(node["else_"])) walk(node["else_"], scope);
        return;
      }
      case "Set": {
        // `targets` is a plain array of names, not a node list.
        const targets = (node["targets"] as unknown[]).filter(isNode);
        let value: Value = OPAQUE;
        if (isNode(node["value"])) value = evalExpr(node["value"], scope);
        else if (isNode(node["body"])) evalExpr(node["body"], scope);
        for (const t of targets) {
          const name = t["value"] as string;
          bind(scope, name, value.tag === "typed" && targets.length === 1 ? { ...value, path: name } : OPAQUE);
        }
        return;
      }
      case "Macro":
        bind(scope, String((node["name"] as NjNode)["value"]), OPAQUE);
        walkCallable(node, scope);
        return;
      case "Include":
        followTemplate(
          "include",
          node["template"] as NjNode,
          scope,
          (s, ref) => ({ ...pushFrame(s), seen: [...s.seen, ref] }),
          node["ignoreMissing"] === true,
        );
        return;
      case "Import":
      case "FromImport": {
        const withContext = node["withContext"] === true;
        followTemplate("import", node["template"] as NjNode, scope, (s, ref) => ({
          frames: [new Map()],
          root: withContext ? fields : [],
          seen: [...s.seen, ref],
        }));
        if (node.typename === "Import") {
          bind(scope, String((node["target"] as NjNode)["value"]), OPAQUE);
        } else {
          for (const n of childNodes(node["names"] as NjNode)) {
            const local = n.typename === "Pair" ? (n["value"] as NjNode) : n;
            bind(scope, String(local["value"]), OPAQUE);
          }
        }
        return;
      }
      case "Extends":
        followTemplate("extends", node["template"] as NjNode, scope, (s, ref) => ({
          frames: [new Map()],
          root: fields,
          seen: [...s.seen, ref],
        }));
        return;
      case "Block":
        walk(node["body"] as NjNode, scope);
        return;
      case "Switch": {
        evalExpr(node["expr"] as NjNode, scope);
        for (const c of childNodes(node["cases"] as NjNode)) {
          evalExpr(c["cond"] as NjNode, scope);
          walk(c["body"] as NjNode, scope);
        }
        if (isNode(node["default"])) walk(node["default"], scope);
        return;
      }
      default:
        // Anything else is an expression in statement position, or a node with
        // expression children: check them rather than skip them.
        evalExpr(node, scope);
    }
  }

  let ast: NjNode;
  try {
    ast = parseJinja(templateText);
  } catch (e) {
    return [{ code: ERR_TEMPLATE_SYNTAX, path: (e as Error).message }];
  }
  walk(ast, { frames: [new Map()], root: fields, seen: [] });
  errors.push(...slotAndTagFindings(referencedAtRoot, staticTexts, opts));
  return errors;
}

/** The static spelling of a name or member chain (`p.title`, `posts[0]`, `user[*]`), or undefined. */
function spellingOf(node: NjNode): string | undefined {
  if (node.typename === "Symbol") return node["value"] as string;
  if (node.typename !== "LookupVal") return undefined;
  const target = spellingOf(node["target"] as NjNode);
  if (target === undefined) return undefined;
  const val = node["val"] as NjNode;
  if (val.typename === "Literal" && typeof val["value"] === "string") return `${target}.${val["value"]}`;
  if (val.typename === "Literal" && typeof val["value"] === "number") return `${target}[${val["value"]}]`;
  return `${target}[*]`;
}

/**
 * The 1-based line `path` is first referenced on in Jinja `text`, for a diagnostic's
 * location: the first expression spelled exactly `path`, else the first use of its head
 * name. Undefined when the text does not parse or never names it here (e.g. the
 * reference is in an included template).
 */
export function jinjaReferenceLine(text: string, path: string): number | undefined {
  const head = path.split(/[.[|]/)[0] ?? path;
  let ast: NjNode;
  try {
    ast = parseJinja(text);
  } catch {
    return undefined;
  }
  let exact: number | undefined;
  let byHead: number | undefined;
  const visit = (node: NjNode): void => {
    if (exact !== undefined) return;
    const spelled = spellingOf(node);
    if (spelled !== undefined && node.lineno !== undefined) {
      if (spelled === path) {
        exact = node.lineno + 1;
        return;
      }
      if (byHead === undefined && node.typename === "Symbol" && spelled === head) byHead = node.lineno + 1;
    }
    for (const child of childNodes(node)) visit(child);
  };
  visit(ast);
  return exact ?? byHead;
}
