// Annotated-template IR (linked-template-source-docs, Task 1).
//
// annotateTemplate parses a Mustache template into an ordered TplToken[] where
// every {{variable}} / {{#section}} is resolved to the payload field it
// references plus that field's doc link. It tokenizes with the SAME parser
// verify walks (`parseTemplate` from @metaobjectsdev/render) and resolves each
// path with verify's EXPORTED `resolveTemplateVariable` — so the annotator and
// the build-time drift gate share ONE resolution and can never disagree (a
// later conformance gate asserts exactly that).
//
// Reuse, not reimplementation:
//   • parseTemplate          — the render verify engine's Mustache.parse.
//   • resolveTemplateVariable — verify's context-stack walk (sections push the
//                               nested subtree; dotted paths descend). Generic
//                               over the node, so an ENRICHED tree (carrying
//                               owner/type/required) resolves identically.
//
// The annotator is a pure function over an enriched payload tree + the source —
// no metadata import, no I/O — so it is unit-testable and golden-pinnable.

import {
	parseTemplate,
	resolveTemplateVariable,
	type PayloadField,
	type ResolveStack,
} from "@metaobjectsdev/render";
import { fieldAnchorSlug } from "./field-anchor.js";

/**
 * An enriched payload-field node. Structurally a verify `PayloadField` (so the
 * shared resolver walks it), plus the per-field doc metadata the annotator needs
 * to emit a `ResolvedField` + link: `owner` (the VO that declares the field),
 * `type`, and `required`. Container fields (object / array-of-object) carry
 * `fields` whose nodes are owned by the nested VO.
 */
export interface AnnotatePayloadField extends PayloadField {
	owner: string;
	type: string;
	required: boolean;
	fields?: AnnotatePayloadField[];
}

/** The field a `{{variable}}` / `{{#section}}` resolves to. */
export interface ResolvedField {
	owner: string;
	name: string;
	type: string;
	required: boolean;
}

/** One ordered token of the annotated template. `raw` is the verbatim source
 *  span of the tag (text tokens carry `text`), so the source round-trips. */
export type TplToken =
	| { kind: "text"; text: string }
	| {
			kind: "var" | "unescaped";
			raw: string;
			path: string;
			field?: ResolvedField;
			href?: string;
			valid: boolean;
	  }
	| {
			kind: "section" | "inverted" | "close";
			raw: string;
			path: string;
			field?: ResolvedField;
			href?: string;
	  }
	| { kind: "partial"; raw: string; ref: string; href?: string }
	| { kind: "comment"; raw: string };

export interface AnnotateOptions {
	/** The root payload VO's short name (owner of the root-context fields). Used
	 *  only for diagnostics / callers; per-field owner comes off the tree node. */
	ownerVoName: string;
	/**
	 * Resolve a partial `{{>ref}}` to a doc-page href, if the ref names a
	 * documented template. Returns the href or undefined (highlight-only).
	 * Optional — when absent, partials are captured ref-only (no href).
	 */
	resolvePartialHref?: (ref: string) => string | undefined;
}

// A Mustache parse token: [type, value, start, end, subTokens?, closeStart?, ...].
type Token = readonly unknown[];

/** The doc-page href for a resolved field: `./<OwnerVO>.md#field-<name>`. The
 *  anchor slug comes from the SHARED `fieldAnchorSlug()` (prefixed — avoids
 *  colliding with other page anchors), the SAME helper the entity page uses to
 *  emit its per-field `<a id="field-<name>">` anchor, so the link and the anchor
 *  can never drift. */
function fieldHref(owner: string, name: string): string {
	return `./${owner}.md#${fieldAnchorSlug(name)}`;
}

function toResolvedField(f: AnnotatePayloadField): ResolvedField {
	return { owner: f.owner, name: f.name, type: f.type, required: f.required };
}

/**
 * Parse `source` into an annotated IR, resolving each variable/section against
 * the enriched `payload` tree using verify's shared resolution.
 */
export function annotateTemplate(
	source: string,
	payload: AnnotatePayloadField[],
	opts: AnnotateOptions,
): TplToken[] {
	const root = payload;
	const out: TplToken[] = [];
	let cursor = 0;

	// Emit verbatim source between `cursor` and `to` as a text token, advancing
	// the cursor. This recovers literal text AND any span Mustache trimmed as
	// standalone (e.g. the newline after a standalone partial/section), so the
	// concatenated tokens reproduce the source byte-for-byte.
	function emitTextUpTo(to: number): void {
		if (to > cursor) {
			out.push({ kind: "text", text: source.slice(cursor, to) });
			cursor = to;
		}
	}

	function resolveAt(
		stack: ResolveStack<AnnotatePayloadField>,
		path: string,
	): { field: ResolvedField; href: string } | undefined {
		const hit = resolveTemplateVariable(stack, path);
		if (!hit) return undefined;
		const field = toResolvedField(hit);
		return { field, href: fieldHref(field.owner, field.name) };
	}

	function walk(
		tokens: Token[],
		stack: ResolveStack<AnnotatePayloadField>,
	): void {
		for (const tok of tokens) {
			const type = tok[0] as string;
			const value = tok[1] as string;
			const start = tok[2] as number;
			const end = tok[3] as number;

			// Recover any source between the previous token and this tag (literal
			// text, or trimmed standalone whitespace).
			emitTextUpTo(start);

			switch (type) {
				case "text": {
					out.push({ kind: "text", text: source.slice(start, end) });
					cursor = end;
					break;
				}
				case "name": {
					// {{x}} — escaped variable.
					const raw = source.slice(start, end);
					cursor = end;
					if (value === ".") {
						// Implicit iterator — always valid, references the current context.
						out.push({ kind: "var", raw, path: value, valid: true });
						break;
					}
					const r = resolveAt(stack, value);
					out.push(
						r
							? {
									kind: "var",
									raw,
									path: value,
									field: r.field,
									href: r.href,
									valid: true,
								}
							: { kind: "var", raw, path: value, valid: false },
					);
					break;
				}
				case "&":
				case "{": {
					// {{&x}} / {{{x}}} — unescaped variable (mustache.js emits "&" for both).
					const raw = source.slice(start, end);
					cursor = end;
					if (value === ".") {
						out.push({ kind: "unescaped", raw, path: value, valid: true });
						break;
					}
					const r = resolveAt(stack, value);
					out.push(
						r
							? {
									kind: "unescaped",
									raw,
									path: value,
									field: r.field,
									href: r.href,
									valid: true,
								}
							: { kind: "unescaped", raw, path: value, valid: false },
					);
					break;
				}
				case "#":
				case "^": {
					// {{#x}}…{{/x}} (section) / {{^x}}…{{/x}} (inverted). `end` is the end
					// of the OPENING tag; subTokens at [4]; [5] is where the closing tag
					// begins. Emit the open tag, recurse the body in the pushed context,
					// then emit the close tag.
					const sub = Array.isArray(tok[4]) ? (tok[4] as Token[]) : [];
					const closeStart = tok[5] as number;
					const openRaw = source.slice(start, end);
					cursor = end;

					const isImplicit = value === ".";
					const r = isImplicit ? undefined : resolveAt(stack, value);
					const kind = type === "#" ? "section" : "inverted";
					out.push(
						r
							? {
									kind,
									raw: openRaw,
									path: value,
									field: r.field,
									href: r.href,
								}
							: { kind, raw: openRaw, path: value },
					);

					// `#` over a container pushes its element fields; `^` (and `#` over a
					// scalar conditional) keep the current context — EXACTLY verify's rule.
					const hit = isImplicit
						? undefined
						: resolveTemplateVariable(stack, value);
					const nested = type === "#" ? hit?.fields : undefined;
					const childStack: ResolveStack<AnnotatePayloadField> =
						nested !== undefined ? [...stack, nested] : stack;
					walk(sub, childStack);

					// The closing tag `{{/value}}` runs from closeStart to the end of the
					// section. Recover any body remainder Mustache trimmed, then emit close.
					emitTextUpTo(closeStart);
					// The close tag's exact end isn't in the token; derive it from the
					// literal `{{/…}}` form starting at closeStart so the raw is verbatim.
					const closeRaw = readCloseTag(source, closeStart, value);
					out.push({ kind: "close", raw: closeRaw, path: value });
					cursor = closeStart + closeRaw.length;
					break;
				}
				case ">": {
					// {{>ref}} — partial.
					const raw = source.slice(start, end);
					cursor = end;
					const href = opts.resolvePartialHref?.(value);
					out.push(
						href !== undefined
							? { kind: "partial", raw, ref: value, href }
							: { kind: "partial", raw, ref: value },
					);
					break;
				}
				case "!": {
					// {{! comment }}.
					out.push({ kind: "comment", raw: source.slice(start, end) });
					cursor = end;
					break;
				}
				default: {
					// set-delimiter (=) or any other: preserve verbatim as text.
					if (Number.isFinite(end) && end > start) {
						out.push({ kind: "text", text: source.slice(start, end) });
						cursor = end;
					}
					break;
				}
			}
		}
	}

	walk(parseTemplate(source) as Token[], [root]);
	// Any trailing source after the last token (e.g. a standalone-trimmed final
	// newline) is recovered as text.
	emitTextUpTo(source.length);

	return out;
}

// Read the verbatim closing tag `{{/name}}` (with any inner whitespace the
// author wrote) starting at `from`. Mustache only gives the close-tag start, so
// we locate the terminating `}}` from there to recover the exact source span.
function readCloseTag(source: string, from: number, _name: string): string {
	const close = source.indexOf("}}", from);
	if (close === -1) return source.slice(from);
	return source.slice(from, close + 2);
}
