/**
 * The site payload — everything metaobjects.dev publishes, assembled once and gated
 * on the way out.
 *
 * The site's strongest claim is that its code blocks are real `meta gen` output. This
 * module is where that claim is made true rather than asserted: every snippet is READ
 * from the artifact it claims to come from, and four gates run during assembly, each
 * throwing rather than degrading. A payload that builds is a payload whose claims held.
 *
 *   subsequence   a published excerpt must still be an in-order subsequence of the real
 *                 generated file, so a renamed symbol or a dropped export fails here
 *                 instead of shipping. Elisions are COMPUTED from the match, so the
 *                 page cannot imply contiguity it does not have.
 *   drift fixture the `verify` transcript must still be a FAILING run. A fixture gone
 *                 green would publish a screenshot of an error that no longer happens.
 *   requirements  `meta verify` on the showcase must exit 0, so the requirements page's
 *                 "resolved, not trusted" claim is checked rather than repeated.
 *   home paths    the assembled JSON must carry no absolute user path. This repo is
 *                 public and the payload publishes to a public site.
 *
 * Deterministic by construction: no timestamps, no durations (normalizeTranscript
 * replaces them), and object keys in registry order — so a rebuild that changed nothing
 * is byte-identical and `--check` means something.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { SNIPPETS, type SnippetSource } from "./snippets.js";
import { extractMarkedRegion } from "./markers.js";
import { splitLines, matchSubsequence, renderWithElisions } from "./subsequence.js";
import { loadVocabulary, highlightMetadata, type Vocabulary } from "./highlight-metadata.js";
import { highlightCode } from "./highlight-code.js";
import { captureTranscript, normalizeTranscript, HOME_PATH } from "./transcript.js";

export interface Snippet {
  lang: string;
  /** Highlighted HTML of what the page shows inline. */
  inline: string;
  /** Highlighted HTML of the whole generated file, for expand-to-view. */
  full: string | null;
  /** Lines in the full file — the page says "N lines" on the expander. */
  lineCount: number | null;
}

export interface Registries {
  npm: string; pypi: string; nuget: string; maven: string; metamodel: string;
}

export interface SitePayload {
  registries: Registries;
  snippets: Record<string, Snippet>;
}

const REGISTRY_MANIFEST = "fixtures/registry-conformance/expected-registry.json";

/**
 * The showcase's prompt text lives in `templates/`, not `verify`'s default `prompts/`.
 * Omitting this yields ERR_PARTIAL_UNRESOLVED — a failure about where a file lives,
 * which would masquerade as the payload-drift signal these two captures are about.
 * The same flag is on the drift capture in snippets.ts, for the same reason.
 */
const PROMPTS_ARGS = ["--prompts", "templates"];

const read = (repoRoot: string, rel: string) => readFileSync(resolve(repoRoot, rel), "utf8");

/** First capture of `re` in a file, or a throw naming what was being looked for. */
function readVersion(repoRoot: string, rel: string, re: RegExp, what: string): string {
  const m = re.exec(read(repoRoot, rel));
  const v = m?.[1];
  if (v === undefined) throw new Error(`site payload: could not read the ${what} version from ${rel}`);
  return v;
}

/**
 * Five coordinates, never one string. The registries do NOT share a version — Maven
 * runs on its historical major 7 — so a single `version` field could only be right for
 * three of the four, and the page would state the wrong one somewhere. `metamodel` is a
 * separate contract again (ADR-0035 Amendment 2): it moves when the METADATA changes,
 * independently of any package line.
 */
function readRegistries(repoRoot: string): Registries {
  return {
    npm: readVersion(repoRoot, "server/typescript/packages/cli/package.json",
      /"version":\s*"([^"]+)"/, "npm"),
    pypi: readVersion(repoRoot, "server/python/pyproject.toml",
      /^version\s*=\s*"([^"]+)"/m, "PyPI"),
    nuget: readVersion(repoRoot, "server/csharp/Directory.Build.props",
      /<Version>([^<]+)<\/Version>/, "NuGet"),
    maven: readVersion(repoRoot, "server/java/pom.xml",
      /<version>([^<]+)<\/version>/, "Maven"),
    metamodel: readVersion(repoRoot, REGISTRY_MANIFEST,
      /"metamodelVersion":\s*"([^"]+)"/, "metamodel"),
  };
}

/**
 * A hand-authored file, delimited in place. Already whole — nothing to expand to.
 *
 * Vocabulary is deliberately NOT gated here. highlightMetadata is tolerant by design:
 * no key allow-list can be complete (`attr.properties` is a chartered arbitrary bag,
 * and `attr.expression`/`attr.filter` carry their own grammars whose inner keys are not
 * registry attrs), so a throw would be a false-positive generator — measured at 8 false
 * failures against the real corpora. The vocabulary gate is the LOADER, which is
 * strictly stronger and has none: a marked region lives inside a real model, and
 * `assertRequirementsResolve` loads it.
 *
 * `lang` is "yaml" rather than the registry's value: a marker's content is metadata
 * YAML by construction (that is what highlightMetadata renders), and `Lang` — the
 * highlight-code language set — has no member for it, so the registry cannot say so.
 */
function markerSnippet(repoRoot: string, id: string, src: Extract<SnippetSource, { kind: "marker" }>,
                       vocab: Vocabulary): Snippet {
  const region = extractMarkedRegion(read(repoRoot, src.file), id);
  return { lang: "yaml", inline: highlightMetadata(region, vocab), full: null, lineCount: null };
}

/**
 * Machine-owned output, published as an excerpt. The excerpt is not trusted: it must be
 * an in-order subsequence of the real file, and where it skips, the elision marker is
 * computed from the match rather than authored — which is exactly how the landing page
 * came to claim "this exact model" while eliding three members.
 */
function excerptSnippet(repoRoot: string, id: string,
                        src: Extract<SnippetSource, { kind: "excerpt" }>): Snippet {
  const inlineLines = splitLines(read(repoRoot, src.inline));
  const fullText = read(repoRoot, src.full);
  const fullLines = splitLines(fullText);

  const m = matchSubsequence(inlineLines, fullLines);
  if (!m.ok) {
    throw new Error(
      `site payload: snippet "${id}" is stale.\n` +
      `  ${src.inline} line ${m.failedAt + 1} is not present, in order, in ${src.full}:\n` +
      `    ${m.line.trim()}\n` +
      `  The site would publish it as real generated output. Re-cut the excerpt.`);
  }

  const rendered = renderWithElisions(inlineLines, m.positions, fullLines.length);
  return {
    lang: src.lang,
    inline: highlightCode(rendered.join("\n"), src.lang),
    full: highlightCode(fullText, src.lang),
    lineCount: fullLines.length,
  };
}

/**
 * Machine-owned output short enough to publish ENTIRE. The published text IS the file,
 * a stricter guarantee than any excerpt, so there is no subsequence gate and nothing to
 * expand to.
 */
function wholeSnippet(repoRoot: string, src: Extract<SnippetSource, { kind: "whole" }>): Snippet {
  return {
    lang: src.lang,
    inline: highlightCode(read(repoRoot, src.file), src.lang),
    full: null,
    lineCount: null,
  };
}

/**
 * Live CLI output. The exit code is the gate: this transcript exists to show `verify`
 * CATCHING drift, so a fixture that started passing would leave the page showing an
 * error the tool no longer emits — true once, false now, and invisible in a diff
 * because the captured text would simply change.
 */
function transcriptSnippet(repoRoot: string, id: string,
                           src: Extract<SnippetSource, { kind: "transcript" }>): Snippet {
  const { text, exitCode } = captureTranscript(src.argv, resolve(repoRoot, src.cwd));
  if (exitCode === 0) {
    throw new Error(
      `site payload: the "${id}" fixture now PASSES (exit 0).\n` +
      `  It is published as a demonstration of \`meta ${src.argv.join(" ")}\` catching drift.\n` +
      `  A passing fixture means the page would show an error that no longer happens.`);
  }
  return {
    lang: "console",
    inline: highlightCode(normalizeTranscript(text, repoRoot), "console"),
    full: null,
    lineCount: null,
  };
}

/**
 * The requirements page claims a requirement's `implementedBy` is RESOLVED, not
 * trusted. `meta verify` is what resolves it, so the claim is only true while this
 * exits 0 — and a dangling reference is an ERROR, so a broken link cannot hide in the
 * warning cap.
 */
function assertRequirementsResolve(repoRoot: string): void {
  const showcase = resolve(repoRoot, "examples/showcase");
  const { text, exitCode } = captureTranscript(["verify", ...PROMPTS_ARGS], showcase);
  if (exitCode !== 0) {
    throw new Error(
      `site payload: \`meta verify\` fails on examples/showcase (exit ${exitCode}).\n` +
      `  The site publishes its requirement links as resolved; they are not.\n\n` +
      normalizeTranscript(text, repoRoot));
  }
}

export function buildPayload(repoRoot: string): SitePayload {
  const vocab = loadVocabulary(resolve(repoRoot, REGISTRY_MANIFEST));

  const snippets: Record<string, Snippet> = {};
  for (const [id, src] of Object.entries(SNIPPETS)) {
    switch (src.kind) {
      case "marker":     snippets[id] = markerSnippet(repoRoot, id, src, vocab); break;
      case "excerpt":    snippets[id] = excerptSnippet(repoRoot, id, src); break;
      case "whole":      snippets[id] = wholeSnippet(repoRoot, src); break;
      case "transcript": snippets[id] = transcriptSnippet(repoRoot, id, src); break;
    }
  }

  assertRequirementsResolve(repoRoot);

  const payload: SitePayload = { registries: readRegistries(repoRoot), snippets };

  // Final sweep. HOME_PATH is IMPORTED, never respelled here: two spellings of one rule
  // is how the weaker one ends up being the one that runs. normalizeTranscript already
  // applies it to captured output; this catches a leak arriving by any other route —
  // an absolute path baked into a committed excerpt, say.
  const leak = HOME_PATH.exec(JSON.stringify(payload));
  if (leak) {
    throw new Error(
      `site payload: absolute home path ${leak[0]} — this repository is public and the ` +
      `payload publishes to a public site. Refusing to emit it.`);
  }
  return payload;
}
