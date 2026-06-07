package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.apidocs.ApiUnit;
import com.metaobjects.generator.apidocs.DocsPaths;
import com.metaobjects.generator.apidocs.JavaApiDocsRenderer;
import com.metaobjects.generator.apidocs.JavaApiModel;
import com.metaobjects.generator.apidocs.JavaApiModelBuilder;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.plugins.annotations.ResolutionScope;

import java.io.UncheckedIOException;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * {@code metaobjects:docs} — emit the generated Java SDK api surface (the SP-1
 * {@code apiSurfaces} {@code api/java} surface) into a configurable subdir.
 *
 * <p>Extends {@link AbstractMetaDataMojo} so it inherits metadata loading from the
 * {@code <loader>} config: the base {@link AbstractMetaDataMojo#execute()} builds the
 * {@link MetaDataLoader} and then calls the {@link #executeGenerators(MetaDataLoader, List)}
 * hook. This goal needs only the loaded loader, not configured {@code <generators>}, so it
 * ignores the (empty) generator list and instead builds + renders the api-docs IR:
 * <ul>
 *   <li>{@link JavaApiModelBuilder#build(MetaDataLoader, String)} → the api-surface IR;</li>
 *   <li>{@link JavaApiDocsRenderer#renderUnitPage(ApiUnit, String)} per unit (with a
 *       {@link DocsPaths#modelCrossHref} link back to its model/metadata page);</li>
 *   <li>{@link JavaApiDocsRenderer#renderIndex(JavaApiModel, DocsPaths.Layout)} → README.md;</li>
 *   <li>{@link JavaApiDocsRenderer#renderAgentApi(JavaApiModel)} → AGENT-API.md.</li>
 * </ul>
 *
 * <p>The Mojo is wiring only: every name comes from the IR and every path from
 * {@link DocsPaths} — nothing is re-derived here. Output paths are collision-checked
 * (duplicate page path → build failure), mirroring the TS {@code assertNoDuplicateDocPaths}.
 */
@Mojo(name = "docs",
        requiresDependencyResolution = ResolutionScope.COMPILE_PLUS_RUNTIME,
        defaultPhase = LifecyclePhase.GENERATE_RESOURCES)
public class DocsMojo extends AbstractMetaDataMojo {

    /** Root output dir for docs; the api surface lands under {@link #apiSubDir}. */
    @Parameter(property = "metaobjects.docs.outputDirectory",
            defaultValue = "${project.build.directory}/docs")
    private java.io.File outputDirectory;

    /** Subdir (under {@link #outputDirectory}) for the {@code api/java} surface. */
    @Parameter(property = "metaobjects.docs.apiSubDir", defaultValue = "api/java")
    private String apiSubDir;

    /** Doc-page layout: {@code flat} (one file per unit) or {@code package} (foldered). */
    @Parameter(property = "metaobjects.docs.layout", defaultValue = "flat")
    private String layout;

    /** Optional base URL for federated model docs; when unset, model links are relative. */
    @Parameter(property = "metaobjects.docs.modelBaseUrl")
    private String modelBaseUrl;

    @Override
    public void execute() throws MojoExecutionException, MojoFailureException {
        // Inherit loader construction + the executeGenerators hook from the base.
        super.execute();
    }

    @Override
    protected void executeGenerators(MetaDataLoader loader, List<Generator> generatorImpls) {
        DocsPaths.Layout lay = "package".equalsIgnoreCase(layout)
                ? DocsPaths.Layout.PACKAGE : DocsPaths.Layout.FLAT;

        String projectName = project != null ? project.getArtifactId() : "project";
        JavaApiModel model = new JavaApiModelBuilder().build(loader, projectName);
        JavaApiDocsRenderer renderer = new JavaApiDocsRenderer();

        Path apiRoot = outputDirectory.toPath().resolve(apiSubDir);

        // Collect path -> rendered content first, so a duplicate page path fails the
        // build BEFORE anything is written (collision safety).
        Map<String, String> emitted = new LinkedHashMap<>();
        for (ApiUnit unit : model.units()) {
            // Page path relative to the api-subdir root (names + paths from the IR/DocsPaths).
            String pagePath = DocsPaths.docPageOutputPath(lay, unit.pkg(), unit.node());
            // The api page lives under apiSubDir; the model page lives at the docs root.
            String apiPagePathFromDocsRoot = apiSubDir + "/" + pagePath;
            String modelPagePath = pagePath;
            String modelHref = DocsPaths.modelCrossHref(
                    apiPagePathFromDocsRoot, modelPagePath, modelBaseUrl);
            put(emitted, pagePath, renderer.renderUnitPage(unit, modelHref));
        }
        put(emitted, "README.md", renderer.renderIndex(model, lay));
        put(emitted, "AGENT-API.md", renderer.renderAgentApi(model));

        try {
            for (Map.Entry<String, String> e : emitted.entrySet()) {
                Path dest = apiRoot.resolve(e.getKey());
                Files.createDirectories(dest.getParent());
                Files.writeString(dest, e.getValue(), StandardCharsets.UTF_8);
            }
        } catch (IOException ex) {
            throw new UncheckedIOException("metaobjects:docs — failed writing api pages into " + apiRoot, ex);
        }

        getLog().info("metaobjects:docs — wrote " + emitted.size()
                + " api pages into " + apiRoot);
    }

    /** Insert into the emit map, failing on a duplicate output path (collision guard). */
    private static void put(Map<String, String> emitted, String path, String content) {
        if (emitted.containsKey(path)) {
            throw new IllegalStateException(
                    "metaobjects:docs — duplicate api page output path: " + path);
        }
        emitted.put(path, content);
    }
}
