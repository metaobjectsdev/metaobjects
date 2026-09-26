package com.metaobjects.generator;

import com.metaobjects.generator.util.GeneratedFileWriter;
import com.metaobjects.loader.MetaDataLoader;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

/**
 * The short way to write a generator of your own on the JVM (ADR-0034 Amendment 4): return
 * the files, and this base writes them under the {@code outputDir} arg.
 *
 * <pre>{@code
 * public class FieldListGenerator extends FileEmittingGenerator {
 *     @Override
 *     protected List<EmittedFile> generate(MetaDataLoader loader) {
 *         List<EmittedFile> out = new ArrayList<>();
 *         for (MetaObject o : ModelWalk.concreteObjects(loader)) {
 *             out.add(new EmittedFile(ModelWalk.name(o) + ".txt", String.join("\n", ...)));
 *         }
 *         return out;
 *     }
 * }
 * }</pre>
 *
 * Wire it in the pom like any generator — {@code <classname>} plus an
 * {@code <args><outputDir>}{@code </outputDir></args>} — from a module the plugin's
 * classpath can see (the {@code codegen/} module {@code mvn metaobjects:eject} scaffolds is
 * one). {@code mvn metaobjects:verify} re-runs it into a temp dir and diffs, with nothing to
 * register.
 *
 * <p><b>Writing.</b> A file whose content carries this toolchain's {@code GENERATED} header
 * comment goes through {@link GeneratedFileWriter}, so an existing file WITHOUT the marker —
 * one someone took ownership of — is refused with a warning, exactly as for the reference
 * generators. Content that carries no such header (JSON, YAML — formats that cannot hold a
 * comment) is written as given: the marker rule would let run 1 write it and refuse it on
 * every run after, freezing it behind a green build.
 */
public abstract class FileEmittingGenerator extends GeneratorBase {

    /** One output file: {@code path} relative to {@code outputDir}, and its final contents. */
    public record EmittedFile(String path, String content) {}

    /** Build the files. Read the model through {@link ModelWalk}. */
    protected abstract List<EmittedFile> generate(MetaDataLoader loader);

    @Override
    public void execute(MetaDataLoader loader) {
        if (!hasArg(ARG_OUTPUTDIR)) {
            throw new GeneratorException(getClass().getSimpleName()
                + ": set the output directory with <args><" + ARG_OUTPUTDIR + ">…</" + ARG_OUTPUTDIR + "></args>");
        }
        Path outDir = Path.of(getArg(ARG_OUTPUTDIR));
        for (EmittedFile f : generate(loader)) {
            Path target = outDir.resolve(f.path()).normalize();
            if (!target.startsWith(outDir.normalize())) {
                throw new GeneratorException(getClass().getSimpleName() + ": path escapes outputDir: " + f.path());
            }
            try {
                if (GeneratedFileWriter.looksGenerated(f.content())) {
                    GeneratedFileWriter.write(target, f.content());
                } else {
                    if (target.getParent() != null) Files.createDirectories(target.getParent());
                    Files.writeString(target, f.content(), StandardCharsets.UTF_8);
                }
            } catch (IOException e) {
                throw new GeneratorException(getClass().getSimpleName() + ": could not write " + target + ": " + e, e);
            }
        }
    }
}
