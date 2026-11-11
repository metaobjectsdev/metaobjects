package com.metaobjects.generator;

import com.metaobjects.config.SharedModel;
import com.metaobjects.generator.FileEmittingGenerator;
import com.metaobjects.generator.GeneratorException;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.registry.MetaDataTypeProvider;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * FR-023: publishes a project's shared model - a flattened, canonical-JSON artifact plus the
 * manifest that pins it - for a consumer's {@code meta deps sync}.
 *
 * <p>This file decides what belongs to the PUBLISHING PROJECT: which of its source files may
 * contribute ({@code files}), which nodes are published ({@code include} / {@code exclude}) and
 * which version is recorded. Everything a consumer checks is {@link SharedModel}'s, in the package:
 * what is selected, that the selection is closed, the document's bytes, the hash over them and the
 * manifest's shape and file names. It is a reference helper (ADR-0034 Amendment 3):
 * {@code mvn metaobjects:eject -Dnames=shared-model} copies this one file into your project, and
 * the artifact bytes stay in the package, because a copy that changed them would publish a model a
 * consumer's sync refuses, or accepts and cannot load.</p>
 *
 * <p>Args: {@code outputDir}, {@code name} (the dependency key a consumer syncs under; the artifact
 * is {@code <name>.metaobjects.json}), {@code include} (comma-separated scope patterns, such as
 * {@code acme::common::**}), {@code files} (comma-separated metadata files that may contribute),
 * and optionally {@code exclude} (applied after {@code include}), {@code version} (default: the
 * project's version) and {@code requirements} ({@code true} publishes the selected
 * {@code requirement.*} nodes as well; default {@code false}).</p>
 */
public class SharedModelGenerator extends FileEmittingGenerator {

    public static final String ARG_NAME = "name";
    public static final String ARG_INCLUDE = "include";
    public static final String ARG_EXCLUDE = "exclude";
    public static final String ARG_FILES = "files";
    public static final String ARG_VERSION = "version";
    public static final String ARG_REQUIREMENTS = "requirements";

    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        String name = required(ARG_NAME, "the dependency key a consumer will sync under");
        List<String> include = list(required(ARG_INCLUDE, "the scope patterns to publish, such as acme::common::**"));
        List<String> exclude = hasArg(ARG_EXCLUDE) ? list(getArg(ARG_EXCLUDE)) : List.of();
        List<Path> files = new ArrayList<>();
        for (String f : list(required(ARG_FILES, "the metadata files that may contribute, comma-separated"))) {
            files.add(Path.of(f));
        }
        // The providers the project's own load used, so its extra attributes load here too.
        List<MetaDataTypeProvider> providers = loader.getLoaderOptions().getProviders();

        // Publishing the ledger is opt-in: "true" adds the selected requirement.* nodes.
        boolean requirements = hasArg(ARG_REQUIREMENTS) && Boolean.parseBoolean(getArg(ARG_REQUIREMENTS).trim());

        SharedModel.Built model = SharedModel.build(
            new SharedModel.Input(name, files, include, exclude, providers, requirements));

        // Resolved after the selection has passed every check, so a model that cannot be published
        // says so before a missing version does.
        String version = hasArg(ARG_VERSION) && !getArg(ARG_VERSION).isBlank() ? getArg(ARG_VERSION).trim() : null;
        if (version == null || version.isBlank()) {
            throw new GeneratorException("shared-model \"" + name + "\": no version available - set <args><"
                + ARG_VERSION + ">...</" + ARG_VERSION + "></args>, or run through the Maven plugin, which supplies ${project.version}.");
        }

        SharedModel.Files out = SharedModel.render(model, version);
        return List.of(new EmittedFile(out.artifactPath(), out.artifact()),
                       new EmittedFile(out.manifestPath(), out.manifest()));
    }

    private String required(String arg, String what) {
        String value = getArg(arg);
        if (value == null || value.isBlank()) {
            throw new GeneratorException("shared-model: set '" + arg + "' with <args><" + arg + ">...</" + arg
                + "></args> (" + what + ")");
        }
        return value.trim();
    }

    private static List<String> list(String commaSeparated) {
        List<String> out = new ArrayList<>();
        for (String part : commaSeparated.split(",")) {
            if (!part.isBlank()) out.add(part.trim());
        }
        return out;
    }
}
