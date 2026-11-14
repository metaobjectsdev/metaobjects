package com.metaobjects.mojo;

import com.metaobjects.generator.kotlin.KotlinEntityGenerator;
import org.junit.Test;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The verify goal refuses the model the generate goal refuses: two metadata packages that would
 * generate into one output directory (#546, ERR_NAME_COLLISION). Before, only generate ran the
 * check, so a project whose committed tree predated the clash verified clean.
 */
public class MetaDataVerifyModelRefusalTest {

    private static void configure(AbstractMetaDataMojo mojo, Path outputDir) {
        mojo.setLoader(LoaderParam.builder("layout-collision")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir("./src/test/resources")
                .withSources(List.of("mojo/layout-collision/meta.sales-upper.json", "mojo/layout-collision/meta.sales-lower.json"))
                .build());
        mojo.setGenerators(List.of(GeneratorParam.builder(KotlinEntityGenerator.class.getName())
                .withArg("outputDir", outputDir.toString())
                .build()));
        mojo.setGlobals(Collections.emptyMap());
    }

    private static void assertRefused(AbstractMetaDataMojo mojo) {
        try {
            mojo.execute();
            fail("expected the run to be refused with ERR_NAME_COLLISION");
        } catch (Exception e) {
            StringBuilder messages = new StringBuilder();
            for (Throwable t = e; t != null; t = t.getCause()) messages.append(t.getMessage()).append('\n');
            assertTrue(messages.toString(), messages.toString().contains("ERR_NAME_COLLISION"));
        }
    }

    @Test
    public void generateRefusesTwoPackagesInOneDirectory() throws Exception {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, Files.createTempDirectory("layout-gen"));
        assertRefused(gen);
    }

    @Test
    public void verifyRefusesTwoPackagesInOneDirectory() throws Exception {
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, Files.createTempDirectory("layout-verify"));
        assertRefused(verify);
    }
}
