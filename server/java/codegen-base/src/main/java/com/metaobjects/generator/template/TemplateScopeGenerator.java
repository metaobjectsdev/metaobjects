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

        List<MetaObject> objects = loader.getMetaObjects();
        List<EmittedFile> files = TemplateGenerator.generate(
            scope,
            template,
            root -> ScopeWalk.forScope(scope, outputPattern).apply(objects),
            provider,
            format,
            objects);

        for (EmittedFile f : files) {
            Path target = outDir.toPath().resolve(f.path());
            try {
                Files.createDirectories(target.getParent());
                Files.writeString(target, f.content());
            } catch (IOException e) {
                throw new GeneratorException(
                    "Failed to write template-codegen output [" + target + "]: " + e.getMessage(), e);
            }
        }
    }
}
