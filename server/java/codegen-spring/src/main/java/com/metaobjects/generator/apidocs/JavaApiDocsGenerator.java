package com.metaobjects.generator.apidocs;

// Eject note (ADR-0034 Amendment 8): `mvn metaobjects:eject -Dnames=api-docs` copies this file with the
// api reference's IR, builder, renderer and templates. The siblings below stay in their packages as
// engine, so each is imported by name — a bare same-package reference would not resolve from the copy.
import com.metaobjects.generator.DocsGenerator;
import com.metaobjects.generator.FileEmittingGenerator;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.generator.apidocs.GeneratorApplicability;
import com.metaobjects.loader.MetaDataLoader;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * {@code api-docs} — the Java SDK api reference (the {@code api/java} surface of the cross-port
 * SDK-docs contract): one page per entity, value object, projection, served report and template,
 * an index, and the agent-facing {@code AGENT-API.md}.
 *
 * <p>Run by {@code mvn metaobjects:docs}, not by {@code mvn metaobjects:generate}: it implements
 * {@link DocsGenerator}, which {@code generate} and {@code verify} skip. Its files land under
 * {@code outputDir}, the docs directory, in {@link #ARG_API_SUBDIR}. The project label, the layout
 * and the model back-link base come from the {@link DocsGenerator} args the goal sets.</p>
 *
 * <p>What each documented generator emits for comes from {@link #applicability}, so this
 * generator names no emitting generator. The default is the packaged generators' answers. A
 * project that owns a copy of one of them changes that one line of its copy of this class to ask
 * its own.</p>
 */
public final class JavaApiDocsGenerator extends FileEmittingGenerator implements DocsGenerator {

    /** The api-surface subdirectory of the cross-port docs contract. */
    public static final String DEFAULT_API_SUBDIR = "api/java";

    private static final String LAYOUT_PACKAGE = "package";

    /** What each documented generator emits for. Replace it to describe an owned copy. */
    private final GeneratorApplicability applicability = GeneratorApplicability.packaged();

    @Override
    public String surface() {
        return "java";
    }

    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        String project = getArg(ARG_PROJECT_NAME, "project");
        String subDir = getArg(ARG_API_SUBDIR, DEFAULT_API_SUBDIR);
        String modelBaseUrl = hasArg(ARG_MODEL_BASE_URL) ? getArg(ARG_MODEL_BASE_URL) : null;
        DocsPaths.Layout layout = LAYOUT_PACKAGE.equalsIgnoreCase(getArg(ARG_LAYOUT, "flat"))
                ? DocsPaths.Layout.PACKAGE : DocsPaths.Layout.FLAT;

        JavaApiModel model = new JavaApiModelBuilder(applicability).build(loader, project);
        JavaApiDocsRenderer renderer = new JavaApiDocsRenderer();

        List<EmittedFile> pages = new ArrayList<>();
        Set<String> paths = new HashSet<>();
        for (ApiUnit unit : model.units()) {
            String pagePath = DocsPaths.docPageOutputPath(layout, unit.pkg(), unit.node());
            String modelHref = DocsPaths.modelCrossHref(subDir + "/" + pagePath, pagePath, modelBaseUrl);
            add(pages, paths, subDir, pagePath, renderer.renderUnitPage(unit, modelHref));
        }
        add(pages, paths, subDir, "README.md", renderer.renderIndex(model, layout));
        add(pages, paths, subDir, "AGENT-API.md", renderer.renderAgentApi(model));
        return pages;
    }

    /** Add one page, failing on a path two units resolve to. */
    private static void add(List<EmittedFile> pages, Set<String> paths, String subDir, String pagePath,
                            String content) {
        if (!paths.add(pagePath)) {
            throw new GeneratorException("api-docs: duplicate api page output path: " + pagePath);
        }
        pages.add(new EmittedFile(subDir + "/" + pagePath, content));
    }
}
