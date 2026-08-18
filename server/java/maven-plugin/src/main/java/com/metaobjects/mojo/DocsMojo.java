package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.plugins.annotations.ResolutionScope;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * {@code metaobjects:docs} — emit the generated SDK api surface (the SP-1 {@code apiSurfaces}
 * surface) into a configurable subdir, for one or more languages.
 *
 * <p>Extends {@link AbstractMetaDataMojo} so it inherits metadata loading from the
 * {@code <loader>} config: the base {@link AbstractMetaDataMojo#execute()} builds the
 * {@link MetaDataLoader} and then calls the {@link #executeGenerators(MetaDataLoader, List)}
 * hook. This goal needs only the loaded loader, not configured {@code <generators>}, so it
 * ignores the (empty) generator list and instead builds + renders the api-docs IR.
 *
 * <p>The {@link #language} parameter selects the native SDK surface:
 * <ul>
 *   <li>{@code java} (default) — the {@code codegen-spring} Java surface ({@code api/java});</li>
 *   <li>{@code kotlin} — the {@code codegen-kotlin} Kotlin surface ({@code api/kotlin});</li>
 *   <li>{@code java,kotlin} — both surfaces, each into its own subdir.</li>
 * </ul>
 * Each language's surface defaults its own {@code apiSubDir} ({@code api/<lang>}); set
 * {@link #apiSubDir} explicitly only when documenting a single language into a custom dir.
 *
 * <p>The Mojo is wiring only: every name comes from the per-language IR and every path from that
 * port's {@code DocsPaths} (byte-parity with the TS contract) — nothing is re-derived here. Output
 * paths are collision-checked (duplicate page path → build failure), mirroring the TS
 * {@code assertNoDuplicateDocPaths}.
 */
@Mojo(name = "docs",
        requiresDependencyResolution = ResolutionScope.COMPILE_PLUS_RUNTIME,
        defaultPhase = LifecyclePhase.GENERATE_RESOURCES,
        threadSafe = true)   // #233
public class DocsMojo extends AbstractMetaDataMojo {

    private static final String LANG_JAVA = "java";
    private static final String LANG_KOTLIN = "kotlin";

    /** Root output dir for docs; each surface lands under its {@code apiSubDir}. */
    @Parameter(property = "metaobjects.docs.outputDirectory",
            defaultValue = "${project.build.directory}/docs")
    private java.io.File outputDirectory;

    /**
     * Which native SDK surface(s) to emit — comma-separated {@code java} / {@code kotlin}.
     * Default {@code java} (back-compat: the goal emitted only {@code api/java} before the
     * Kotlin surface landed).
     */
    @Parameter(property = "metaobjects.docs.language", defaultValue = LANG_JAVA)
    private String language;

    /**
     * Subdir (under {@link #outputDirectory}) for the api surface. Unset → each language uses its
     * own default ({@code api/<lang>}). Set this only when emitting a single language to a custom
     * dir; with multiple languages an explicit value would collide and is rejected.
     */
    @Parameter(property = "metaobjects.docs.apiSubDir")
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
        // Default to java when unset (the MojoRule test harness does not apply @Parameter
        // defaultValue; a real Maven run does — guard both paths).
        String langSpec = (language == null || language.trim().isEmpty()) ? LANG_JAVA : language;
        String[] langs = langSpec.split(",");
        boolean multi = langs.length > 1;
        if (multi && apiSubDir != null && !apiSubDir.isEmpty()) {
            throw new IllegalStateException(
                    "metaobjects:docs — an explicit <apiSubDir> cannot be shared across multiple "
                            + "languages (" + language + "); omit it so each uses api/<lang>");
        }

        String projectName = project != null ? project.getArtifactId() : "project";
        boolean packageLayout = "package".equalsIgnoreCase(layout);

        for (String raw : langs) {
            String lang = raw.trim().toLowerCase(Locale.ROOT);
            if (lang.isEmpty()) {
                continue;
            }
            String subDir = (apiSubDir != null && !apiSubDir.isEmpty()) ? apiSubDir : ("api/" + lang);
            Map<String, String> emitted;
            switch (lang) {
                case LANG_JAVA:
                    emitted = renderJava(loader, projectName, subDir, packageLayout);
                    break;
                case LANG_KOTLIN:
                    emitted = renderKotlin(loader, projectName, subDir, packageLayout);
                    break;
                default:
                    throw new IllegalStateException(
                            "metaobjects:docs — unknown language '" + lang
                                    + "' (supported: java, kotlin)");
            }
            writeSurface(subDir, emitted);
        }
    }

    // ----- Java surface (codegen-spring) -------------------------------------

    private Map<String, String> renderJava(MetaDataLoader loader, String projectName,
                                           String subDir, boolean packageLayout) {
        com.metaobjects.generator.apidocs.DocsPaths.Layout lay = packageLayout
                ? com.metaobjects.generator.apidocs.DocsPaths.Layout.PACKAGE
                : com.metaobjects.generator.apidocs.DocsPaths.Layout.FLAT;
        com.metaobjects.generator.apidocs.JavaApiModel model =
                new com.metaobjects.generator.apidocs.JavaApiModelBuilder().build(loader, projectName);
        com.metaobjects.generator.apidocs.JavaApiDocsRenderer renderer =
                new com.metaobjects.generator.apidocs.JavaApiDocsRenderer();

        Map<String, String> emitted = new LinkedHashMap<>();
        for (com.metaobjects.generator.apidocs.ApiUnit unit : model.units()) {
            String pagePath = com.metaobjects.generator.apidocs.DocsPaths.docPageOutputPath(
                    lay, unit.pkg(), unit.node());
            String apiPagePathFromDocsRoot = subDir + "/" + pagePath;
            String modelHref = com.metaobjects.generator.apidocs.DocsPaths.modelCrossHref(
                    apiPagePathFromDocsRoot, pagePath, modelBaseUrl);
            put(emitted, pagePath, renderer.renderUnitPage(unit, modelHref));
        }
        put(emitted, "README.md", renderer.renderIndex(model, lay));
        put(emitted, "AGENT-API.md", renderer.renderAgentApi(model));
        return emitted;
    }

    // ----- Kotlin surface (codegen-kotlin) -----------------------------------

    private Map<String, String> renderKotlin(MetaDataLoader loader, String projectName,
                                             String subDir, boolean packageLayout) {
        com.metaobjects.generator.kotlin.apidocs.DocsPaths.Layout lay = packageLayout
                ? com.metaobjects.generator.kotlin.apidocs.DocsPaths.Layout.PACKAGE
                : com.metaobjects.generator.kotlin.apidocs.DocsPaths.Layout.FLAT;
        com.metaobjects.generator.kotlin.apidocs.KotlinApiModel model =
                new com.metaobjects.generator.kotlin.apidocs.KotlinApiModelBuilder().build(loader, projectName);
        com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsRenderer renderer =
                new com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsRenderer();

        Map<String, String> emitted = new LinkedHashMap<>();
        for (com.metaobjects.generator.kotlin.apidocs.ApiUnit unit : model.getUnits()) {
            String pagePath = com.metaobjects.generator.kotlin.apidocs.DocsPaths.INSTANCE
                    .docPageOutputPath(lay, unit.getPkg(), unit.getNode());
            String apiPagePathFromDocsRoot = subDir + "/" + pagePath;
            String modelHref = com.metaobjects.generator.kotlin.apidocs.DocsPaths.INSTANCE
                    .modelCrossHref(apiPagePathFromDocsRoot, pagePath, modelBaseUrl);
            put(emitted, pagePath, renderer.renderUnitPage(unit, modelHref));
        }
        put(emitted, "README.md", renderer.renderIndex(model, lay));
        put(emitted, "AGENT-API.md", renderer.renderAgentApi(model));
        return emitted;
    }

    // ----- write -------------------------------------------------------------

    /** Write a language surface's pages under {@code outputDirectory/subDir}. */
    private void writeSurface(String subDir, Map<String, String> emitted) {
        Path apiRoot = outputDirectory.toPath().resolve(subDir);
        try {
            for (Map.Entry<String, String> e : emitted.entrySet()) {
                Path dest = apiRoot.resolve(e.getKey());
                // NOT routed through GeneratedFileWriter, deliberately. That guard refuses
                // any existing file lacking the `GENERATED` marker, and these API pages are
                // rendered from `templates/api/*.mustache` — none of which emits the token,
                // and none of which is obliged to. Guarding them made the FIRST run write and
                // every run after silently refuse, so the docs froze while the build stayed
                // green and still reported "wrote N api pages".
                //
                // The marker floor protects output whose header WE control. Doc pages
                // rendered from a user-editable template are not that; the guard belongs on
                // the first-party generators, which were each verified to emit the token.
                Files.createDirectories(dest.getParent());
                Files.writeString(dest, e.getValue(), StandardCharsets.UTF_8);
            }
        } catch (IOException ex) {
            throw new UncheckedIOException("metaobjects:docs — failed writing api pages into " + apiRoot, ex);
        }
        getLog().info("metaobjects:docs — wrote " + emitted.size() + " api pages into " + apiRoot);
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
