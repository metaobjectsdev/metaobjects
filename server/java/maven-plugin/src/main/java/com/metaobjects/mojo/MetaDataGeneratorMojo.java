package com.metaobjects.mojo;

import com.metaobjects.generator.Generator;
import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;
import org.apache.maven.plugins.annotations.LifecyclePhase;
import org.apache.maven.plugins.annotations.Mojo;
import org.apache.maven.plugins.annotations.ResolutionScope;

import java.io.File;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.*;
import java.util.stream.Stream;

@Mojo(name="generate",
        requiresDependencyResolution= ResolutionScope.COMPILE_PLUS_RUNTIME,
        defaultPhase = LifecyclePhase.GENERATE_SOURCES,
        threadSafe = true)   // #233: safe under `mvn -T` once the registry warm-up + per-instance loader key land
public class MetaDataGeneratorMojo extends AbstractMetaDataMojo
{
    @Override
    protected void executeGenerators(MetaDataLoader loader, List<Generator> generatorImpls) {

        // This loop IS the Java port's runner — the one place that spans generators — so it
        // is the only place that can see two of them claiming one output path. TypeScript's
        // runGen and Python's run_gen both refuse that; until this scope existed, Java could
        // not, and a selection whose output depended on generator order produced a WARN and
        // a green build. Opening the run here is what makes the check reach a real build.
        try (GeneratedFileWriter.Run run = GeneratedFileWriter.beginRun()) {
            for( Generator gen : generatorImpls ) {
                getLog().info("MetaData Mojo > Executing Generator: " + gen.getClass().getName() );
                run.attributeTo( gen.getClass().getSimpleName() );
                gen.execute( loader );
            }
        }

        registerGeneratedSourceRoots();
    }

    /**
     * F23: {@code metaobjects:generate} used to write generated classes to disk and stop —
     * nothing ever called {@link org.apache.maven.project.MavenProject#addCompileSourceRoot},
     * so {@code mvn compile} in an adopter module compiled zero of them unless the adopter
     * hand-added {@code build-helper-maven-plugin} to point the compiler at the output dir.
     * The other ports need no such step (their output is read by a bundler/interpreter that
     * walks whatever directory it is told about); the JVM compiler plugin only compiles
     * source ROOTS it has been told exist.
     *
     * <p>Registers a directory only after generation actually ran, and only when it holds at
     * least one {@code .java}/{@code .kt} file — evidence, not declared intent. A generator's
     * {@code outputDir} is not necessarily Java/Kotlin source: {@link
     * com.metaobjects.generator.template.TemplateScopeGenerator} emits whatever a
     * user-supplied Mustache template renders (SQL, markdown, CSV), and the HTML/AI
     * documentation generators write docs. Scanning what actually landed on disk — rather
     * than assuming every {@code outputDir} is a source root — keeps a docs-only or
     * data-file-only run from being registered as a source root nothing will ever compile
     * from, which would be silently harmless to {@code javac} but wrong to claim.
     *
     * <p>{@code generate-test-sources} registers a TEST compile root (mirroring the phase
     * this goal was bound to); every other phase, including the default {@code
     * generate-sources} binding, registers a main one.
     */
    private void registerGeneratedSourceRoots() {
        if (getGenerators() == null || project == null) return;

        boolean testPhase = execution != null
                && PHASE_GENERATE_TEST_SOURCES.equals(execution.getLifecyclePhase());

        Set<String> seen = new LinkedHashSet<>();
        for (GeneratorParam g : getGenerators()) {
            Map<String, String> merged = mergeAndOverwriteArgs(g);
            String dir = merged.get(GeneratorBase.ARG_OUTPUTDIR);
            if (dir == null) continue;

            String abs = new File(dir).getAbsoluteFile().toPath().normalize().toString();
            if (!seen.add(abs)) continue;
            if (!holdsCompilableSource(Path.of(abs))) continue;

            if (testPhase) {
                project.addTestCompileSourceRoot(abs);
                getLog().info("MetaData Mojo > Registered test compile source root: " + abs);
            } else {
                project.addCompileSourceRoot(abs);
                getLog().info("MetaData Mojo > Registered compile source root: " + abs);
            }
        }
    }

    /** Whether {@code dir} holds at least one {@code .java} or {@code .kt} file, recursively. */
    private static boolean holdsCompilableSource(Path dir) {
        if (!Files.isDirectory(dir)) return false;
        try (Stream<Path> walk = Files.walk(dir)) {
            return walk.anyMatch(p -> Files.isRegularFile(p) && isSourceFile(p));
        } catch (IOException e) {
            throw new UncheckedIOException("Could not scan generated output dir [" + dir + "]", e);
        }
    }

    private static boolean isSourceFile(Path p) {
        String name = p.getFileName() == null ? "" : p.getFileName().toString();
        return name.endsWith(".java") || name.endsWith(".kt");
    }
}
