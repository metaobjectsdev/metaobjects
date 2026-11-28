package com.metaobjects.generator;

// Eject note (ADR-0034 Amendment 8): `mvn metaobjects:eject -Dnames=metamodel-docs` copies this file.
// What there is to emit (the page data) and the templates stay in com.metaobjects.docs.metamodel and on
// the classpath, so the copy can change where the pages go and how they are laid out, and a project
// that wants other page text puts a same-path template earlier on the classpath or names a `metamodelTemplateDir`.
import com.metaobjects.docs.metamodel.MetamodelDocsEmitter;
import com.metaobjects.generator.FileEmittingGenerator;
import com.metaobjects.loader.MetaDataLoader;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * {@code metamodel-docs}: the reference of the built-in metamodel (every type, subtype and attribute the
 * build registers, by provider): {@code INDEX.md}, {@code providers.md} and one {@code types/<family>.md}
 * per type family, rendered from the shared {@code templates/metamodel/} Mustache set.
 *
 * <p>It reads no model objects: the vocabulary is the build's own registry. Args: {@code outputDir}
 * (required), {@code subDir} (where under it the pages land, default {@link #DEFAULT_SUB_DIR}; empty
 * writes at the root) and {@code metamodelTemplateDir} (a directory holding {@code metamodel/<page>.mustache}
 * overrides). Give it an {@code outputDir} that holds generated files only.</p>
 */
public class MetamodelDocsGenerator extends FileEmittingGenerator {

    /** Arg: where under {@code outputDir} the pages land. */
    public static final String ARG_SUB_DIR = "subDir";

    /** Arg: a directory holding {@code metamodel/<page>.mustache} that win over the packaged templates. */
    public static final String ARG_TEMPLATE_DIR = "metamodelTemplateDir";

    public static final String DEFAULT_SUB_DIR = "metamodel";

    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        String subDir = getArg(ARG_SUB_DIR, DEFAULT_SUB_DIR);
        Path templateDir = hasArg(ARG_TEMPLATE_DIR) ? Path.of(getArg(ARG_TEMPLATE_DIR)) : null;
        List<EmittedFile> files = new ArrayList<>();
        for (Map.Entry<String, String> page : MetamodelDocsEmitter.emit(subDir, templateDir).entrySet()) {
            files.add(new EmittedFile(page.getKey(), page.getValue()));
        }
        return files;
    }
}
