package com.metaobjects.mojo;

import com.metaobjects.generator.DocsGenerator;
import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.plugins.annotations.ResolutionScope;

import java.util.HashMap;
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
 * hook. This goal needs only the loaded loader. It reads the configured {@code <generators>}
 * for one thing: a {@link DocsGenerator} it names for a surface, which it runs in place of the
 * packaged one. Every other configured generator is left alone.
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
 * <p>The Mojo is wiring only: each surface is a {@link DocsGenerator} ({@code api-docs}) that
 * writes its pages under {@link #outputDirectory}. When the project's {@code <generators>} list
 * holds a docs generator for a surface, the goal runs that one, so a project that ejected
 * {@code api-docs} runs its own copy. Every name comes from the per-language IR and every path
 * from that port's {@code DocsPaths} (byte-parity with the TS contract) — nothing is re-derived
 * here. Output paths are collision-checked (duplicate page path → build failure), mirroring the TS
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

        for (String raw : langs) {
            String lang = raw.trim().toLowerCase(Locale.ROOT);
            if (lang.isEmpty()) {
                continue;
            }
            String subDir = (apiSubDir != null && !apiSubDir.isEmpty()) ? apiSubDir : ("api/" + lang);
            runSurface(lang, subDir, loader, generatorImpls);
        }
    }

    /**
     * Run the docs generator for one surface: the one the project's {@code <generators>} list
     * names for it, when it names one (an owned copy of {@code api-docs}), else the packaged one.
     * The goal is wiring only: every page, name and path comes from the generator.
     */
    private void runSurface(String lang, String subDir, MetaDataLoader loader, List<Generator> generatorImpls) {
        DocsGenerator docs = null;
        Map<String, String> args = null;
        for (int i = 0; i < generatorImpls.size(); i++) {
            if (generatorImpls.get(i) instanceof DocsGenerator
                    && lang.equals(((DocsGenerator) generatorImpls.get(i)).surface())) {
                docs = (DocsGenerator) generatorImpls.get(i);
                args = mergeAndOverwriteArgs(getGenerators().get(i));
                break;
            }
        }
        boolean owned = docs != null;
        if (!owned) {
            docs = packaged(lang);
            args = new HashMap<>();
            if (getGlobals() != null) args.putAll(getGlobals());
            docs.setFilters(List.of());
        }

        args.put(GeneratorBase.ARG_OUTPUTDIR, outputDirectory.getAbsolutePath());
        args.put(DocsGenerator.ARG_PROJECT_NAME, project != null ? project.getArtifactId() : "project");
        args.put(DocsGenerator.ARG_API_SUBDIR, subDir);
        args.put(DocsGenerator.ARG_LAYOUT, "package".equalsIgnoreCase(layout) ? "package" : "flat");
        if (modelBaseUrl != null && !modelBaseUrl.isEmpty()) {
            args.put(DocsGenerator.ARG_MODEL_BASE_URL, modelBaseUrl);
        }
        docs.setArgs(args);
        docs.execute(loader);
        getLog().info("metaobjects:docs — ran " + (owned ? "your" : "the packaged") + " " + lang
                + " api-docs generator " + docs.getClass().getName() + " into "
                + outputDirectory.toPath().resolve(subDir));
    }

    /** The packaged {@code api-docs} generator for a surface. */
    private static DocsGenerator packaged(String lang) {
        switch (lang) {
            case LANG_JAVA:
                return new com.metaobjects.generator.apidocs.JavaApiDocsGenerator();
            case LANG_KOTLIN:
                return new com.metaobjects.generator.kotlin.apidocs.KotlinApiDocsGenerator();
            default:
                throw new IllegalStateException(
                        "metaobjects:docs — unknown language '" + lang + "' (supported: java, kotlin)");
        }
    }
}
