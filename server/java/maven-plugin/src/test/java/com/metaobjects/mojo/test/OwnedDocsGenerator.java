package com.metaobjects.mojo.test;

import com.metaobjects.generator.DocsGenerator;
import com.metaobjects.generator.FileEmittingGenerator;
import com.metaobjects.loader.MetaDataLoader;

import java.util.List;

/** A docs generator of the adopter's own, for the goals that run or skip one. */
public class OwnedDocsGenerator extends FileEmittingGenerator implements DocsGenerator {

    @Override
    public String surface() {
        return "java";
    }

    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        String project = getArg(ARG_PROJECT_NAME, "none");
        String subDir = getArg(ARG_API_SUBDIR, "api/unset");
        return List.of(new EmittedFile(subDir + "/OWNED.md", "owned docs for " + project + "\n"));
    }
}
