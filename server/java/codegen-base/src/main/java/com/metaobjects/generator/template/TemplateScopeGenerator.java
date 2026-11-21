package com.metaobjects.generator.template;

import com.metaobjects.generator.GeneratorBase;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.render.FilesystemProvider;
import com.metaobjects.render.Provider;
import com.metaobjects.render.templategen.EmittedFile;
import com.metaobjects.render.templategen.TemplateGenerator;

import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.stream.Collectors;

/**
 * Maven-wirable declarative Mustache template generator (SP-1b). Reads the
 * cross-port spec fields as args — {@code template}, {@code scope},
 * {@code outputPattern}, {@code format} (default {@code text}), {@code templatesDir}
 * (the project templates root) — builds the named {@link ScopeWalk} over the
 * loaded model, renders via the byte-equivalent {@link TemplateGenerator}, and
 * writes each file under {@code outputDir}.
 *
 * <p>Wire in {@code pom.xml} via the standard generator mechanism:
 * <pre>{@code
 * <generator>
 *   <classname>com.metaobjects.generator.template.TemplateScopeGenerator</classname>
 *   <args>
 *     <templatesDir>src/main/templates</templatesDir>
 *     <template>service/entity-service</template>
 *     <scope>perEntity</scope>
 *     <outputPattern>{package}/{Name}Service.java</outputPattern>
 *     <outputDir>${project.build.directory}/generated-sources/java</outputDir>
 *   </args>
 * </generator>
 * }</pre>
 */
public class TemplateScopeGenerator extends GeneratorBase {

    public static final String ARG_TEMPLATE = "template";
    public static final String ARG_SCOPE = "scope";
    public static final String ARG_OUTPUT_PATTERN = "outputPattern";
    public static final String ARG_FORMAT = "format";
    public static final String ARG_TEMPLATES_DIR = "templatesDir";

    /** The template root is an input (ADR-0064): editing a template regenerates. */
    @Override
    public java.util.List<String> extraInputs() {
        return hasArg(ARG_TEMPLATES_DIR) ? java.util.List.of(getArg(ARG_TEMPLATES_DIR)) : java.util.List.of();
    }
    @Override
    public void execute(MetaDataLoader loader) {
        String template = getArg(ARG_TEMPLATE, true);
        String scope = getArg(ARG_SCOPE, true);
        String outputPattern = getArg(ARG_OUTPUT_PATTERN, true);
        String format = getArg(ARG_FORMAT, "text");
        String templatesDir = getArg(ARG_TEMPLATES_DIR, true);

        Path templatesRoot = Paths.get(templatesDir);
        Provider provider = new FilesystemProvider(templatesRoot);
        File outDir = getOutputDir();

        List<MetaObject> objects = com.metaobjects.generator.util.GeneratorUtil.ownMetaObjects(loader);
        List<MetaObject> walked = ScopeWalk.PER_ENTITY.equals(scope)
            ? objects.stream().filter(this::inEntitySelection).collect(Collectors.toList())
            : objects;
        List<EmittedFile> files = TemplateGenerator.generate(
            scope,
            template,
            root -> ScopeWalk.forScope(scope, outputPattern).apply(walked),
            provider,
            format,
            objects);

        for (EmittedFile f : files) {
            Path target = outDir.toPath().resolve(f.path());
            try {
                // Unmarked: this emits whatever a USER's `--template-spec` Mustache renders —
                // SQL, markdown, CSV, anything — and that content carries no obligation to
                // include the `GENERATED` marker. It is still recorded in the hash manifest, so
                // unchanged bytes are not rewritten and a hand edit is refused by name.
                com.metaobjects.generator.util.GeneratedFileWriter.writeUnmarked(target, f.content());
            } catch (IOException e) {
                throw new GeneratorException(
                    "Failed to write template-codegen output [" + target + "]: " + e.getMessage(), e);
            }
        }
    }
}
