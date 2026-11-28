package com.metaobjects.generator;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.docs.explorer.ExplorerSite;
import com.metaobjects.docsview.DocsView;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.generator.util.HashManifest;
import com.metaobjects.loader.MetaDataLoader;

import java.io.IOException;
import java.io.UncheckedIOException;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * {@code docs-site}: the model explorer, one browser app over the project's docs view, written with
 * no Node on the path (the JVM side of TypeScript's {@code docsSiteFile()}, {@code output: "app"}).
 * The Java and Kotlin registries both run this class: the site is language-neutral, so both ports
 * write the same bytes.
 *
 * <p>It builds the docs view from the model this run loaded ({@link DocsView#build}), lists the
 * files this run generated for each node ({@code generatedBy} and {@code sourceNode}, from the open
 * {@link GeneratedFileWriter.Run}), and writes the app, its data script, its stamp and
 * {@code explorer.json} through {@link ExplorerSite}. The runner runs it after every other
 * generator ({@link #readsRunOutput}), so a write run and {@code metaobjects:verify} list the same
 * files. With no run open (a test or an embedder driving it alone) it lists what the hash manifest
 * in {@code genStateDir} records.</p>
 *
 * <p>Args: {@code outputDir} (required); {@code subDir} (default {@code site}; empty writes at the
 * root); {@code title} (default: the project directory's name); {@code stamp} (footer text, default
 * none, so the site depends on the model alone); {@code prompts} (a directory, relative to the
 * project, holding prompt {@code .mustache} sources outside the metadata directories and
 * {@code templates/}); {@code verifyFile} (a {@code verify} JSON payload whose requirement rows the
 * explorer shows, default none); {@code routesFile} (the routes the application mounts,
 * {@code [{ node, method, path }]} with {@code node} a resolution key, default none); {@code genStateDir} (default {@code .metaobjects/.gen-state}) and
 * {@code projectRoot} (default: the working directory; the Maven plugin passes the module's).</p>
 *
 * <p>A project that owns the explorer's theme (what {@code meta eject docs-site} copies into
 * {@code codegen/docs-site/}) has its {@code assets/explorer.css}, {@code assets/explorer.js} and
 * {@code templates/explorer-*.mustache} used in place of the packaged ones.</p>
 */
public class DocsSiteGenerator extends FileEmittingGenerator {

    private static final org.slf4j.Logger log = org.slf4j.LoggerFactory.getLogger(DocsSiteGenerator.class);

    public static final String ARG_SUB_DIR = "subDir";
    public static final String ARG_TITLE = "title";
    public static final String ARG_STAMP = "stamp";
    public static final String ARG_PROMPTS = "prompts";
    public static final String ARG_VERIFY_FILE = "verifyFile";
    public static final String ARG_ROUTES_FILE = "routesFile";
    public static final String ARG_GEN_STATE_DIR = "genStateDir";
    public static final String ARG_PROJECT_ROOT = "projectRoot";

    public static final String DEFAULT_SUB_DIR = "site";
    /** Where an owned explorer theme lives, under the project (TypeScript's {@code OWNED_DOCS_SITE_DIR}). */
    public static final String OWNED_DOCS_SITE_DIR = "codegen/docs-site";
    static final String DEFAULT_GEN_STATE_DIR = ".metaobjects/.gen-state";

    /**
     * The owned theme, the prompts directory and the verify payload are read beside the model
     * (ADR-0064): editing one regenerates. The hash manifest is not an input: the files the site
     * lists are the ones this run generates, which follow from the model and these inputs.
     */
    @Override
    public List<String> extraInputs() {
        Path project = Path.of(getArg(ARG_PROJECT_ROOT, System.getProperty("user.dir")));
        List<String> inputs = new ArrayList<>();
        inputs.add(project.resolve(OWNED_DOCS_SITE_DIR).toString());
        if (hasArg(ARG_PROMPTS)) inputs.add(project.resolve(getArg(ARG_PROMPTS)).toString());
        if (hasArg(ARG_VERIFY_FILE)) inputs.add(project.resolve(getArg(ARG_VERIFY_FILE)).toString());
        if (hasArg(ARG_ROUTES_FILE)) inputs.add(project.resolve(getArg(ARG_ROUTES_FILE)).toString());
        return inputs;
    }

    @Override
    public boolean readsRunOutput() {
        return true;
    }

    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        Path project = Path.of(getArg(ARG_PROJECT_ROOT, System.getProperty("user.dir"))).toAbsolutePath().normalize();
        String dir = getArg(ARG_SUB_DIR, DEFAULT_SUB_DIR).replaceAll("/+$", "");
        String prefix = dir.isEmpty() ? "" : dir + "/";

        JsonElement verify = hasArg(ARG_VERIFY_FILE) ? readJson(project.resolve(getArg(ARG_VERIFY_FILE))) : null;
        Path genState = project.resolve(getArg(ARG_GEN_STATE_DIR, DEFAULT_GEN_STATE_DIR));
        JsonElement routes = hasArg(ARG_ROUTES_FILE) ? readJson(project.resolve(getArg(ARG_ROUTES_FILE))) : null;
        GeneratedFileWriter.Run run = GeneratedFileWriter.currentRun();
        Map<String, HashManifest.Provenance> runFiles = run == null ? null : run.generatedFiles();
        JsonObject generated = runFiles != null ? provenanceJson(runFiles)
            : HashManifest.exists(genState) ? provenanceJson(HashManifest.loadProvenance(genState)) : null;
        JsonObject view = DocsView.build(loader.getRoot(), verify, generated, routes);

        Path owned = project.resolve(OWNED_DOCS_SITE_DIR);
        Path assets = owned.resolve("assets");
        Path templates = owned.resolve("templates");
        String title = getArg(ARG_TITLE, project.getFileName() == null ? "Metadata" : project.getFileName().toString());
        Map<String, String> files = ExplorerSite.emit(new ExplorerSite.Input(
            view, title, getArg(ARG_STAMP, ""),
            ExplorerSite.readPromptTexts(view, promptDirs(loader, project)),
            Files.isDirectory(assets) ? assets : null,
            Files.isDirectory(templates) ? templates : null));

        List<EmittedFile> out = new ArrayList<>();
        for (Map.Entry<String, String> f : files.entrySet()) out.add(new EmittedFile(prefix + f.getKey(), f.getValue()));
        return out;
    }

    /** Provenance as the docs view reads it: {@code path → { generatedBy, sourceNode }}. */
    private static JsonObject provenanceJson(Map<String, HashManifest.Provenance> provenance) {
        JsonObject out = new JsonObject();
        for (Map.Entry<String, HashManifest.Provenance> e : provenance.entrySet()) {
            JsonObject entry = new JsonObject();
            entry.addProperty("generatedBy", e.getValue().generatedBy());
            if (e.getValue().sourceNode() != null) entry.addProperty("sourceNode", e.getValue().sourceNode());
            out.add(e.getKey(), entry);
        }
        return out;
    }

    /**
     * Where prompt {@code .mustache} sources are looked for: the directories the model was loaded
     * from, the project's {@code templates/} and the {@code prompts} directory, each once.
     */
    private List<Path> promptDirs(MetaDataLoader loader, Path project) {
        Set<Path> dirs = new LinkedHashSet<>();
        if (loader.getSourceURIs() != null) {
            for (URI uri : loader.getSourceURIs()) {
                if (!"file".equals(uri.getScheme())) continue;
                Path p = Path.of(uri);
                Path parent = Files.isDirectory(p) ? p : p.getParent();
                if (parent != null) dirs.add(parent.toAbsolutePath().normalize());
            }
        }
        Path templates = project.resolve("templates");
        if (Files.isDirectory(templates)) dirs.add(templates);
        if (hasArg(ARG_PROMPTS)) {
            Path prompts = project.resolve(getArg(ARG_PROMPTS)).normalize();
            if (Files.isDirectory(prompts)) dirs.add(prompts);
            else log.warn("docs-site: the prompts directory does not exist: {}", prompts);
        }
        return new ArrayList<>(dirs);
    }

    private static JsonElement readJson(Path p) {
        try {
            return JsonParser.parseString(Files.readString(p, StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new UncheckedIOException("docs-site: could not read " + p, e);
        }
    }
}
