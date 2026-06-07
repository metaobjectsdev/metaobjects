// Walk one `template.output` node (+ root) into the NEUTRAL TemplateDocData
// shape the `docs/template-page.md` Mustache template consumes. The attr reads
// MIRROR render-helper-file.ts / templates/render-helper.ts (@kind, @payloadRef,
// @textRef, @format, @maxChars, @requiredTags; for email @subjectRef /
// @htmlBodyRef / @textBodyRef) — but this builder emits DESCRIPTION, never code:
// no helper signatures, no language types. `capability` is a FIXED, neutral
// sentence per @kind.

import {
  type MetaData,
  type MetaRoot,
  TEMPLATE_ATTR_PAYLOAD_REF,
  TEMPLATE_ATTR_TEXT_REF,
  TEMPLATE_ATTR_FORMAT,
  TEMPLATE_ATTR_MAX_CHARS,
  TEMPLATE_ATTR_KIND,
  TEMPLATE_KIND_EMAIL,
  TEMPLATE_KIND_DOCUMENT,
  TEMPLATE_KIND_DEFAULT,
  TEMPLATE_ATTR_SUBJECT_REF,
  TEMPLATE_ATTR_HTML_BODY_REF,
  TEMPLATE_ATTR_TEXT_BODY_REF,
  TEMPLATE_ATTR_REQUIRED_TAGS,
  DOC_ATTR_DESCRIPTION,
  stripPackage,
} from "@metaobjectsdev/metadata";
import {
  TYPE_TEMPLATE,
  TEMPLATE_SUBTYPE_OUTPUT,
} from "@metaobjectsdev/metadata";
import type { Provider } from "@metaobjectsdev/render";
import { GENERATED_HEADER } from "../constants.js";
import type { OutputLayout } from "../import-path.js";
import { docPageHref, docPageNode, type DocPageNode } from "../docs-paths.js";
import { fieldAnchorSlug } from "./field-anchor.js";
import type { TemplateDocData, TemplateOutputPart } from "./template-doc-data.js";
import { buildEnrichedPayloadTree } from "./template-payload-tree.js";
import { annotateTemplate, type AnnotatePayloadField } from "./template-source-annotate.js";
import {
  renderSourceBlock,
  renderVariablesTable,
  renderRichLinkedHtml,
} from "./template-source-render.js";

export interface BuildTemplateDocDataOpts {
  /** Page-placement layout. Defaults to "flat" (back-compat: same-dir links). */
  layout?: OutputLayout;
  /** Root used to resolve the @payloadRef target's package for a correct
   *  cross-link in package layout. Optional: flat layout never needs it. */
  loadedRoot?: MetaRoot;
  /** The page provider — the SAME one the render-helper drift gate / page
   *  rendering use (e.g. `projectProvider(projectRoot)`). Used to resolve each
   *  referenced mustache's SOURCE TEXT for the "## Template source" section.
   *  Optional: when absent (or a ref doesn't resolve) the section is omitted. */
  provider?: Provider;
}

// FIXED, language-NEUTRAL capability sentences. NO type names, NO signatures.
const CAPABILITY_DOCUMENT =
  "A render helper is generated for this template: it takes the payload and " +
  "returns the rendered output as a single string.";
const CAPABILITY_EMAIL =
  "A render helper is generated for this template: it takes the payload and " +
  "returns the rendered email — subject, HTML body, and an optional text body.";

/** Read an attr that may be a string or string[] (string-array attrs come back
 *  as string[]; a bare comma string is split defensively). Returns a trimmed,
 *  non-empty string list. */
function attrStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((v): v is string => typeof v === "string" && v.length > 0);
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

function readMaxChars(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function templateDescription(t: MetaData): string | undefined {
  const v = t.attr(DOC_ATTR_DESCRIPTION);
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Page-placement node for a metadata object resolved by short name, with the
 *  SAME package-less fallback the Payload cross-link and field hrefs share: when
 *  the object can't be resolved off the root, fall back to a root-level node so a
 *  link is still emitted. Keeps every inbound href routing through the one
 *  `docPageHref(layout, …)` placement. */
function pageNodeByName(root: MetaRoot | undefined, name: string): DocPageNode {
  const obj = root?.findObject(name);
  return obj !== undefined ? docPageNode(obj) : { name };
}

/** Build the TemplateDocData for one `template.output` node. */
export function buildTemplateDocData(
  template: MetaData,
  opts?: BuildTemplateDocDataOpts,
): TemplateDocData {
  const layout = opts?.layout ?? "flat";
  const root = opts?.loadedRoot;
  const kindRaw = ((template.ownAttr(TEMPLATE_ATTR_KIND) as string | undefined) ??
    TEMPLATE_KIND_DEFAULT).toLowerCase();
  const isEmail = kindRaw === TEMPLATE_KIND_EMAIL;
  const kind: "document" | "email" = isEmail ? TEMPLATE_KIND_EMAIL : TEMPLATE_KIND_DOCUMENT;

  const payloadRefRaw = template.ownAttr(TEMPLATE_ATTR_PAYLOAD_REF);
  const payloadName =
    typeof payloadRefRaw === "string" && payloadRefRaw.length > 0
      ? stripPackage(payloadRefRaw)
      : "unknown";

  const requiredTags = attrStringList(template.ownAttr(TEMPLATE_ATTR_REQUIRED_TAGS));
  const maxChars = readMaxChars(template.ownAttr(TEMPLATE_ATTR_MAX_CHARS));

  let format = "";
  let parts: TemplateOutputPart[] | undefined;
  const sourceRefs: string[] = [];

  if (isEmail) {
    const subjectRef = template.ownAttr(TEMPLATE_ATTR_SUBJECT_REF);
    const htmlBodyRef = template.ownAttr(TEMPLATE_ATTR_HTML_BODY_REF);
    const textBodyRef = template.ownAttr(TEMPLATE_ATTR_TEXT_BODY_REF);
    parts = [];
    if (typeof subjectRef === "string") {
      parts.push({ label: "Subject", ref: subjectRef, format: "text", escaped: false });
      sourceRefs.push(subjectRef);
    }
    if (typeof htmlBodyRef === "string") {
      parts.push({ label: "HTML body", ref: htmlBodyRef, format: "html", escaped: true });
      sourceRefs.push(htmlBodyRef);
    }
    if (typeof textBodyRef === "string") {
      parts.push({ label: "Text body", ref: textBodyRef, format: "text", escaped: false });
      sourceRefs.push(textBodyRef);
    }
  } else {
    format = ((template.ownAttr(TEMPLATE_ATTR_FORMAT) as string | undefined) ?? "text").toLowerCase();
    const textRef = template.ownAttr(TEMPLATE_ATTR_TEXT_REF);
    if (typeof textRef === "string") sourceRefs.push(textRef);
  }

  // Cross-link to the payload entity's page. The href is derived from the SAME
  // page-placement function used to write that entity page, so it resolves in
  // BOTH layouts (package layout folds the correct relative path).
  const payloadLink = docPageHref(
    layout,
    docPageNode(template),
    pageNodeByName(root, payloadName),
  );

  const data: TemplateDocData = {
    generatedMarker: `<!-- ${GENERATED_HEADER} — DO NOT EDIT. -->`,
    name: template.name,
    kind,
    isEmail,
    format,
    payload: { name: payloadName, link: payloadLink },
    sourceRefs,
    capability: isEmail ? CAPABILITY_EMAIL : CAPABILITY_DOCUMENT,
  };

  if (parts !== undefined) data.parts = parts;
  if (requiredTags.length > 0) {
    data.requiredTags = requiredTags;
    data.hasRequiredTags = true;
  }
  if (maxChars !== undefined) data.maxChars = maxChars;

  // ── "## Template source" section (Task 4) ────────────────────────────────
  // Resolve each referenced mustache's SOURCE TEXT via the page provider, then
  // annotate it against the ENRICHED payload tree (owner/type/required per node)
  // and pre-render the three doc forms. Only when a provider + a resolvable
  // payload VO are available; a ref that doesn't resolve is skipped (no crash).
  if (opts?.provider !== undefined && root !== undefined && payloadName !== "unknown") {
    const section = buildTemplateSourceSection({
      provider: opts.provider,
      root,
      layout,
      template,
      payloadName,
      // Document: the single @textRef (unlabeled). Email: one labeled part each.
      refs:
        parts !== undefined
          ? parts.map((p) => ({ label: p.label, ref: p.ref }))
          : sourceRefs.map((ref) => ({ ref })),
    });
    if (section !== undefined) data.templateSourceSection = section;
  }

  const desc = templateDescription(template);
  if (desc !== undefined) {
    data.descriptionQuote = desc.split("\n").map((l) => `> ${l}`.trimEnd()).join("\n");
  }

  return data;
}

// One referenced template source to document: an optional human label (email
// part name) + the logical mustache ref (`@textRef` / `@subjectRef` / …).
interface SourceRefSpec {
  label?: string;
  ref: string;
}

interface BuildSectionArgs {
  provider: Provider;
  root: MetaRoot;
  /** Page-placement layout — threaded so field/partial hrefs route through the
   *  SAME docPageHref the Payload cross-link uses (resolves under package layout). */
  layout: OutputLayout;
  /** The `template.output` node whose page is being built — the FROM page for
   *  every relative href on this section. */
  template: MetaData;
  payloadName: string;
  refs: SourceRefSpec[];
}

/**
 * Build the PRE-RENDERED "## Template source" section markdown. For each ref:
 * resolve its mustache source via the provider, annotate it against the enriched
 * payload tree, and emit the fenced source block + the linked variables table +
 * the rich `<details>` linked view. A document template yields one block; an
 * email yields one `### <label>` sub-section per part. Refs whose source the
 * provider can't resolve are skipped (graceful — the build-time drift gate
 * already errors on a truly unresolved ref). Returns `undefined` when NOTHING
 * resolved, so the caller omits the section entirely.
 */
function buildTemplateSourceSection(args: BuildSectionArgs): string | undefined {
  const { provider, root, layout, template, payloadName, refs } = args;
  const tree: AnnotatePayloadField[] = buildEnrichedPayloadTree(root, payloadName);
  const fromNode = docPageNode(template);

  // Layout-aware field href: route through the SAME docPageHref the Payload
  // cross-link uses, so the link lands on the owner VO's REAL page in BOTH
  // layouts (flat → `./Owner.md`, package → `../<pkg>/Owner.md`).
  const fieldHref = (owner: string, name: string): string =>
    `${docPageHref(layout, fromNode, pageNodeByName(root, owner))}#${fieldAnchorSlug(name)}`;

  const resolvePartialHref = makePartialHrefResolver(root, layout, fromNode);
  const isMultipart = refs.length > 1 || refs.some((r) => r.label !== undefined);

  const blocks: string[] = [];
  for (const spec of refs) {
    const source = provider.resolve(spec.ref);
    if (source === undefined) continue; // missing source → skip this part.
    const tokens = annotateTemplate(source, tree, {
      ownerVoName: payloadName,
      resolvePartialHref,
      fieldHref,
    });
    const parts: string[] = [];
    if (isMultipart && spec.label !== undefined) parts.push(`### ${spec.label}`);
    parts.push(renderSourceBlock(tokens));
    const table = renderVariablesTable(tokens);
    if (table !== "") parts.push(table);
    parts.push(renderRichLinkedHtml(tokens));
    blocks.push(parts.join("\n\n"));
  }

  if (blocks.length === 0) return undefined;
  return ["## Template source", "", blocks.join("\n\n")].join("\n");
}

/**
 * A `{{>ref}}` partial-href resolver: returns a relative href to the page of the
 * `template.output` node that documents `ref` (it is one of that template's
 * source refs — @textRef or an email part ref), else undefined (the partial is
 * highlight-only). The href routes through the SAME `docPageHref(layout, …)` the
 * field/Payload links use, so it resolves in BOTH layouts (flat → `./Name.md`,
 * package → a correct relative path like `../comms/OrderEmail.md`).
 */
function makePartialHrefResolver(
  root: MetaRoot,
  layout: OutputLayout,
  fromNode: DocPageNode,
): (ref: string) => string | undefined {
  // Map each documented source ref → the template node that documents it.
  const refToTemplate = new Map<string, MetaData>();
  for (const child of root.ownChildren()) {
    if (child.type !== TYPE_TEMPLATE || child.subType !== TEMPLATE_SUBTYPE_OUTPUT) continue;
    for (const attr of [
      TEMPLATE_ATTR_TEXT_REF,
      TEMPLATE_ATTR_SUBJECT_REF,
      TEMPLATE_ATTR_HTML_BODY_REF,
      TEMPLATE_ATTR_TEXT_BODY_REF,
    ]) {
      const v = child.ownAttr(attr);
      if (typeof v === "string" && v.length > 0 && !refToTemplate.has(v)) {
        refToTemplate.set(v, child);
      }
    }
  }
  return (ref: string) => {
    const node = refToTemplate.get(ref);
    return node !== undefined ? docPageHref(layout, fromNode, docPageNode(node)) : undefined;
  };
}
