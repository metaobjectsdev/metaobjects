// Template-source renderers (linked-template-source-docs, Task 3).
//
// ONE annotated IR (the TplToken[] from annotateTemplate), THREE doc forms — no
// re-derivation, no second parse. All three are pure functions over the tokens:
//
//   • renderSourceBlock     — the verbatim template inside a ```mustache fence.
//                             The annotator round-trips the source via text/raw,
//                             so the fenced body equals the original byte-for-byte
//                             and any viewer/site highlighter colors it.
//   • renderVariablesTable  — a Markdown table of the UNIQUE referenced variables
//                             (vars + sections that resolve to a field), each a
//                             Markdown-native `[owner.name](href)` link (or flagged
//                             "not on payload" when unresolved). Agent-clean.
//   • renderRichLinkedHtml  — a collapsed <details> whose <pre> reproduces the
//                             template with each token in a SELF-CONTAINED
//                             inline-styled <span> (color per kind) and each
//                             resolved variable/section wrapped in a clickable
//                             <a href>. Inline styles only (no external CSS) so it
//                             renders identically on GitHub and a static site.
//
// Color (block + rich view), links (table + rich view), agent-cleanliness (block
// + table) — all from the same source of truth.

import type { TplToken } from "./template-source-annotate.js";

// ── 1. Source block ────────────────────────────────────────────────────────

/**
 * Reconstruct the verbatim template source from the tokens and wrap it in a
 * ```mustache fenced block. Concatenating `text` (text tokens) / `raw` (tag
 * tokens) round-trips the original source byte-for-byte (the annotator pins
 * this), so the fence body is the clean, highlightable source.
 */
export function renderSourceBlock(tokens: TplToken[]): string {
	const source = reconstructSource(tokens);
	return "```mustache\n" + source + "\n```";
}

/** Concatenate the verbatim span of every token (text or tag raw). */
function reconstructSource(tokens: TplToken[]): string {
	let out = "";
	for (const t of tokens) out += t.kind === "text" ? t.text : t.raw;
	return out;
}

// ── 2. Variables table ─────────────────────────────────────────────────────

interface VarRow {
	path: string;
	owner: string | undefined;
	name: string | undefined;
	type: string | undefined;
	required: boolean | undefined;
	href: string | undefined;
}

/** Collect the unique referenced variables (vars/unescaped + sections/inverted
 *  that carry a path), deduped by path, in first-seen order. Implicit-iterator
 *  `.` tokens and close tokens are not "variables" and are skipped. */
function collectVarRows(tokens: TplToken[]): VarRow[] {
	const seen = new Set<string>();
	const rows: VarRow[] = [];
	for (const t of tokens) {
		const isRef =
			t.kind === "var" ||
			t.kind === "unescaped" ||
			t.kind === "section" ||
			t.kind === "inverted";
		if (!isRef) continue;
		if (t.path === "." || seen.has(t.path)) continue;
		seen.add(t.path);
		rows.push({
			path: t.path,
			owner: t.field?.owner,
			name: t.field?.name,
			type: t.field?.type,
			required: t.field?.required,
			href: t.href,
		});
	}
	return rows;
}

/** Markdown-escape a table cell whose text may contain a `|`. */
function mdCell(text: string): string {
	return text.replace(/\|/g, "\\|");
}

/**
 * A Markdown table of the unique referenced variables. Resolved variables link
 * to their field doc (`[owner.name](href)`); unresolved ones are em-dashed and
 * carry a "not on payload" note in the Type cell. Returns "" when there are no
 * variables (keeps the page clean).
 */
export function renderVariablesTable(tokens: TplToken[]): string {
	const rows = collectVarRows(tokens);
	if (rows.length === 0) return "";

	const lines: string[] = [
		"| Variable | Field | Type | Required |",
		"| --- | --- | --- | --- |",
	];
	for (const r of rows) {
		const variable = `\`{{${mdCell(r.path)}}}\``;
		if (r.href && r.owner && r.name) {
			const field = `[${r.owner}.${r.name}](${r.href})`;
			const type = r.type ? mdCell(r.type) : "—";
			const required = r.required ? "yes" : "no";
			lines.push(`| ${variable} | ${field} | ${type} | ${required} |`);
		} else {
			// Unresolved: no field/type/required. Keep the 4-column shape; flag it
			// "not on payload" in the Field cell, em-dash the rest.
			lines.push(`| ${variable} | — (not on payload) | — | — |`);
		}
	}
	return lines.join("\n");
}

// ── 3. Rich linked HTML ────────────────────────────────────────────────────

// Per-kind inline color (self-contained — no external CSS, no classes). Chosen
// for legibility on both GitHub's light/dark Markdown and a generic docs site.
const STYLE_VAR = "color:#0969da"; // blue — escaped/unescaped variable
const STYLE_SECTION = "color:#8250df"; // purple — section / inverted / close
const STYLE_PARTIAL = "color:#1a7f7a"; // teal — partial reference
const STYLE_COMMENT = "color:#6e7781;font-style:italic"; // gray italic — comment

/** HTML-escape literal text so `<`, `>`, `&`, `"` in the template don't break
 *  the surrounding HTML. Quotes are escaped too so token raw is safe in any
 *  attribute-adjacent position. */
function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

/** An inline-styled span for a token kind, escaping the inner verbatim text. */
function styledSpan(style: string, inner: string): string {
	return `<span style="${style}">${inner}</span>`;
}

/** A styled span for a token kind, wrapped in a clickable `<a href>` when the
 *  token resolved to a link (else the bare span). The raw text is HTML-escaped. */
function linkSpan(
	style: string,
	raw: string,
	href: string | undefined,
): string {
	const span = styledSpan(style, escapeHtml(raw));
	return href ? `<a href="${escapeHtml(href)}">${span}</a>` : span;
}

/**
 * The collapsed <details> "Linked view": a <pre> reproducing the template where
 * each token is an inline-styled <span> (color by kind) and each resolved
 * variable/section is additionally wrapped in a clickable <a href>. Whitespace
 * and newlines are preserved inside the <pre>. Collapsed by default (no `open`)
 * so the plain/agent view stays clean; a human expands it for the clickable vars.
 */
export function renderRichLinkedHtml(tokens: TplToken[]): string {
	let pre = "";
	for (const t of tokens) {
		switch (t.kind) {
			case "text": {
				// Default color; escape literal text verbatim (preserves newlines).
				pre += escapeHtml(t.text);
				break;
			}
			case "var":
			case "unescaped": {
				pre += linkSpan(STYLE_VAR, t.raw, t.href);
				break;
			}
			case "section":
			case "inverted":
			case "close": {
				// Only open tags (section/inverted) carry an href; close tags don't.
				const href = "href" in t ? t.href : undefined;
				pre += linkSpan(STYLE_SECTION, t.raw, href);
				break;
			}
			case "partial": {
				pre += linkSpan(STYLE_PARTIAL, t.raw, t.href);
				break;
			}
			case "comment": {
				pre += styledSpan(STYLE_COMMENT, escapeHtml(t.raw));
				break;
			}
		}
	}

	return (
		"<details>\n" +
		"<summary>Linked view</summary>\n\n" +
		'<pre style="white-space:pre-wrap;word-break:break-word">' +
		pre +
		"</pre>\n\n" +
		"</details>"
	);
}
