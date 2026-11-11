package com.metaobjects.generator.apidocs;

// Eject note (ADR-0034 Amendment 8): `mvn metaobjects:eject -Dnames=api-docs` copies this file with the
// api reference's IR, builder, renderer and templates. The siblings below stay in their packages as
// engine, so each is imported by name — a bare same-package reference would not resolve from the copy.
import com.metaobjects.generator.FileEmittingGenerator;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.apidocs.GeneratorApplicability;
import com.metaobjects.loader.MetaDataLoader;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code api-docs} — the Java SDK api reference (the {@code api/java} surface of the cross-port
 * SDK-docs contract): one page per entity, value object, projection, served report and template,
 * an index, and the agent-facing {@code AGENT-API.md}.
 *
 * <p>An ordinary generator: a {@code <generator>} entry in the list {@code mvn
 * metaobjects:generate} runs, and nothing writes these pages for a pom that does not list it
 * (ADR-0034 Amendment 9). Its files land under {@code outputDir} in {@link #ARG_API_SUBDIR}; the
 * project label, the layout and the model back-link base are the other {@code <args>} below.
 * Give it an {@code outputDir} that holds generated files only: {@code mvn metaobjects:verify}
 * compares each output directory as one tree, so a hand-written page there reads as stale.</p>
 *
 * <p>What each documented generator emits for comes from {@link #applicability}, so this
 * generator names no emitting generator. The default is the packaged generators' answers. A
 * project that owns a copy of one of them changes that one line of its copy of this class to ask
 * its own.</p>
 */
public final class JavaApiDocsGenerator extends FileEmittingGenerator {

    /** Arg: the label the agent page carries in its header. Default {@code project}. */
    public static final String ARG_PROJECT_NAME = "projectName";

    /** Arg: where under {@code outputDir} the pages land. Default {@link #DEFAULT_API_SUBDIR}. */
    public static final String ARG_API_SUBDIR = "apiSubDir";

    /** Arg: the page layout, {@code package} (each page under its package path, the default) or
     *  {@code flat} (one file per unit at the surface root, which refuses two same-named units). */
    public static final String ARG_LAYOUT = "layout";

    /** Arg: the base URL the pages' links to the model pages are written against; with none set, the pages carry no such link. */
    public static final String ARG_MODEL_BASE_URL = "modelBaseUrl";

    /** The api-surface subdirectory of the cross-port docs contract. */
    public static final String DEFAULT_API_SUBDIR = "api/java";

    private static final String LAYOUT_FLAT = "flat";
    private static final String LAYOUT_PACKAGE = "package";

    /** What each documented generator emits for. Replace it to describe an owned copy. */
    private final GeneratorApplicability applicability = GeneratorApplicability.packaged();

    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        String project = getArg(ARG_PROJECT_NAME, "project");
        String subDir = getArg(ARG_API_SUBDIR, DEFAULT_API_SUBDIR);
        String modelBaseUrl = hasArg(ARG_MODEL_BASE_URL) ? getArg(ARG_MODEL_BASE_URL) : null;
        // Keyed by package unless the entry asks for flat: a page named by its short name alone
        // collides with a same-named node of another package.
        DocsPaths.Layout layout = layoutOf(getArg(ARG_LAYOUT, LAYOUT_PACKAGE));

        JavaApiModel model = new JavaApiModelBuilder(applicability).build(loader, project);
        JavaApiDocsRenderer renderer = new JavaApiDocsRenderer();

        List<EmittedFile> pages = new ArrayList<>();
        Map<String, String> paths = new HashMap<>();
        for (ApiUnit unit : model.units()) {
            String pagePath = DocsPaths.docPageOutputPath(layout, unit.pkg(), unit.node());
            // No model pages are written beside the api pages, so a relative link would be dead:
            // the link is emitted only against a <modelBaseUrl> that hosts them.
            String modelHref = modelBaseUrl == null || modelBaseUrl.isEmpty() ? null
                    : DocsPaths.modelCrossHref(subDir + "/" + pagePath, pagePath, modelBaseUrl);
            // The unit's Java package is the page's folder, so it names the unit here too.
            String fqn = unit.pkg() == null || unit.pkg().isEmpty() ? unit.node() : unit.pkg() + "." + unit.node();
            add(pages, paths, subDir, pagePath, fqn, renderer.renderUnitPage(unit, modelHref));
        }
        add(pages, paths, subDir, "README.md", "<the api index>", renderer.renderIndex(model, layout));
        add(pages, paths, subDir, "AGENT-API.md", "<the agent page>", renderer.renderAgentApi(model));
        return pages;
    }

    /** The layout a {@link #ARG_LAYOUT} value names. A value that names none is refused: a
     *  misspelt layout would otherwise write every page somewhere its links do not point. */
    private static DocsPaths.Layout layoutOf(String value) {
        if (LAYOUT_FLAT.equals(value)) return DocsPaths.Layout.FLAT;
        if (LAYOUT_PACKAGE.equals(value)) return DocsPaths.Layout.PACKAGE;
        throw new GeneratorException("api-docs: <" + ARG_LAYOUT + "> must be " + LAYOUT_FLAT + " or "
                + LAYOUT_PACKAGE + " (got \"" + value + "\")");
    }

    /** Add one page, failing on a path two units resolve to. Paths are compared case-insensitively:
     *  macOS and Windows hold {@code ProductNdc.md} and {@code ProductNDC.md} as one file, so one
     *  page would silently replace the other. {@code paths} maps a lower-cased path to "path (fqn)". */
    private static void add(List<EmittedFile> pages, Map<String, String> paths, String subDir, String pagePath,
                            String fqn, String content) {
        String prior = paths.putIfAbsent(pagePath.toLowerCase(java.util.Locale.ROOT), pagePath + " (" + fqn + ")");
        if (prior != null) {
            throw new GeneratorException(prior.startsWith(pagePath + " (")
                ? "api-docs: duplicate api page output path " + pagePath + ": " + prior + " and " + fqn
                    + " — rename one of them, or use the package layout."
                : "api-docs: api page output paths " + prior + " and " + pagePath + " (" + fqn + ") differ only"
                    + " in case — one file on a case-insensitive filesystem (macOS, Windows), so one page would"
                    + " replace the other. Rename one of them.");
        }
        pages.add(new EmittedFile(subDir + "/" + pagePath, content));
    }
}
