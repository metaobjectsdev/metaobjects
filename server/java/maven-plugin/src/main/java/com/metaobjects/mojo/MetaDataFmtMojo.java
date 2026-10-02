package com.metaobjects.mojo;

import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.loader.uri.URIHelper;
import com.metaobjects.loader.uri.URIModel;
import org.apache.maven.plugin.MojoExecutionException;
import org.apache.maven.plugin.MojoFailureException;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.Parameter;
import org.apache.maven.plugins.annotations.ResolutionScope;

import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.Arrays;
import java.util.List;
import java.util.stream.Collectors;

/**
 * {@code mvn metaobjects:fmt} — rewrite metadata files into the canonical form
 * the cross-port canonical serializer already produces (#304).
 * {@code -Dmeta.fmt.check=true} lists files that are not canonical and fails
 * the build without changing anything.
 *
 * <p>Overrides {@link #execute()} directly rather than going through the
 * generator-building template {@link AbstractMetaDataMojo#execute()} drives
 * (mirrors {@link MetaDataVerifyMojo}) — fmt has no generator list; it needs
 * several loader instances (the baseline, one fresh reload per candidate
 * file, one empty-rooted loader per file parsed standalone), which the
 * template's single {@code createLoader()} call does not give it.</p>
 *
 * <p>Files: every file {@link AbstractMetaDataMojo#createLoader} resolved for
 * this project — the same {@code <loader><sourceDir>}/{@code <sources>} /
 * {@code .metaobjects/config.json} ladder {@code gen}/{@code verify} use —
 * read back via {@link MetaDataLoader#getSourceURIs()} after the baseline
 * load. {@code -Dmeta.fmt.files=<csv>} narrows the run to a subset.</p>
 */
@Mojo(name = "fmt", requiresDependencyResolution = ResolutionScope.COMPILE_PLUS_RUNTIME, threadSafe = true)
public class MetaDataFmtMojo extends AbstractMetaDataMojo {

    /** {@code -Dmeta.fmt.check=true} — list drift and fail; change nothing. */
    @Parameter(property = "meta.fmt.check", defaultValue = "false")
    boolean check;

    /** {@code -Dmeta.fmt.files=a.json,b.json} — optional explicit subset (relative to the
     *  project basedir, or absolute); must be members of the resolved source list. */
    @Parameter(property = "meta.fmt.files")
    String files;

    @Override
    public void execute() throws MojoExecutionException, MojoFailureException {
        com.metaobjects.registry.RegistryBootstrap.warmUpDefaults();
        if (getLoader() == null) {
            throw new MojoExecutionException("No <loader> element was defined");
        }
        warnIfAgentContextStale();

        ClassLoader projectClassLoader = createProjectClassLoader();
        MetaDataLoader baseline = createLoader(projectClassLoader);

        List<Path> allFiles = resolveFilePaths(baseline);

        List<Path> targets = resolveTargets(allFiles);

        boolean strict = !isLax();
        FmtSupport.RunResult result = FmtSupport.run(
            baseline,
            targets,
            () -> createLoader(projectClassLoader),
            loaderName -> {
                // The loader's NAME becomes the root's own "package" in canonical output
                // (see FmtSupport.formatFile's javadoc — the Java loader-root-name leak the
                // conformance harness also works around), so FmtSupport passes the file's
                // OWN declared package here, never the file's name (which may contain dots
                // a loader name may not — that is a SEPARATE identifier, the `sourceId`
                // CanonicalJsonParser takes, for provenance only).
                MetaDataLoader standalone = new MetaDataLoader(
                    LoaderOptions.create(false, false, strict), MetaDataLoader.SUBTYPE_MANUAL,
                    loaderName);
                standalone.init();
                return standalone;
            },
            check);

        if (result.fatal != null) {
            throw new MojoFailureException(result.fatal);
        }

        if (result.files.isEmpty()) {
            getLog().info("metaobjects:fmt — no metadata files to format.");
            return;
        }

        for (FmtSupport.FileReport r : result.files) {
            getLog().info(describe(r));
        }

        long errored = result.files.stream().filter(f -> f.status == FmtSupport.Status.ERROR).count();
        long needsFormat = result.files.stream().filter(f -> f.status == FmtSupport.Status.WOULD_FORMAT).count();
        long reformatted = result.files.stream().filter(f -> f.status == FmtSupport.Status.FORMATTED).count();

        if (check) {
            if (needsFormat > 0 || errored > 0) {
                throw new MojoFailureException(
                    "metaobjects:fmt -Dmeta.fmt.check=true — " + needsFormat + " file(s) not canonical"
                        + (errored > 0 ? ", " + errored + " error(s)" : "")
                        + ". Run `mvn metaobjects:fmt` to fix.");
            }
            getLog().info("metaobjects:fmt -Dmeta.fmt.check=true — every file is already canonical.");
            return;
        }

        if (errored > 0) {
            throw new MojoFailureException(
                "metaobjects:fmt — " + errored + " file(s) could not be formatted safely (left unchanged).");
        }
        getLog().info("metaobjects:fmt — " + reformatted + " file(s) reformatted.");
    }

    /**
     * The loader's resolved sources come back as {@code model:file:<path>} URIs
     * (see {@link URIHelper}) — a scheme {@link java.nio.file.Paths#get(URI)}
     * cannot handle directly (no NIO provider is registered for it). Unwrap
     * each one to its real on-disk path via {@link URIModel#getUriSource()};
     * a non-{@code file} source (e.g. a classpath {@code resource:}) is
     * skipped — fmt only ever rewrites a real file.
     */
    private List<Path> resolveFilePaths(MetaDataLoader loader) {
        if (loader.getSourceURIs() == null) return List.of();
        return loader.getSourceURIs().stream()
            .map(URIHelper::toURIModel)
            .filter(m -> "file".equals(m.getUriSourceType()))
            .map(m -> Paths.get(m.getUriSource()))
            .collect(Collectors.toList());
    }

    private List<Path> resolveTargets(List<Path> allFiles) throws MojoFailureException {
        if (files == null || files.isBlank()) {
            return allFiles;
        }

        Path base = getProjectBaseDir().toPath();
        List<Path> wanted = Arrays.stream(files.split(","))
            .map(String::trim)
            .filter(s -> !s.isEmpty())
            .map(s -> {
                Path p = Paths.get(s);
                return (p.isAbsolute() ? p : base.resolve(p)).normalize();
            })
            .collect(Collectors.toList());

        List<Path> allNormalized = allFiles.stream().map(Path::toAbsolutePath).map(Path::normalize)
            .collect(Collectors.toList());
        List<Path> missing = wanted.stream().filter(p -> !allNormalized.contains(p)).collect(Collectors.toList());
        if (!missing.isEmpty()) {
            throw new MojoFailureException(
                "not among this project's resolved metadata sources: "
                    + missing.stream().map(Path::toString).collect(Collectors.joining(", "))
                    + "\nmetaobjects:fmt only formats files the metadata-location ladder already "
                    + "resolves — omit -Dmeta.fmt.files to format every one of them.");
        }

        return allFiles.stream()
            .filter(p -> wanted.contains(p.toAbsolutePath().normalize()))
            .collect(Collectors.toList());
    }

    private String describe(FmtSupport.FileReport r) {
        String rel;
        try {
            rel = getProjectBaseDir().toPath().relativize(r.path).toString();
        } catch (IllegalArgumentException e) {
            rel = r.path.toString();
        }
        switch (r.status) {
            case FORMATTED: return "  reformatted  " + rel;
            case WOULD_FORMAT: return "  not canonical  " + rel;
            case UNCHANGED: return "  ok           " + rel;
            case SKIPPED_YAML: return "  skipped (yaml)     " + rel + " — " + r.detail;
            case SKIPPED_OVERLAY: return "  skipped (overlay)  " + rel
                + " — this file declares an overlay fmt cannot resolve standalone";
            case ERROR: return "  error        " + rel + " — " + r.detail;
            default: return "  " + r.status + "  " + rel;
        }
    }

    /** {@inheritDoc} Unused — {@link #execute()} is overridden directly (see class doc). */
    @Override
    protected void executeGenerators(MetaDataLoader loader, List<com.metaobjects.generator.Generator> generatorImpls) {
        // No-op: execute() above orchestrates fmt directly, same pattern as MetaDataVerifyMojo.
    }
}
