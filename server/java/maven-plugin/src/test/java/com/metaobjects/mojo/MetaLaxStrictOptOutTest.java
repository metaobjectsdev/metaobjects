package com.metaobjects.mojo;

import com.metaobjects.MetaDataException;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Test;

import java.util.Collections;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * {@code meta.lax} strict opt-out for the {@code metaobjects:generate} /
 * {@code metaobjects:verify} goals (#96).
 *
 * <p>Under 7.5.x sealed strict provenance (ADR-0023), an own {@code @}-attribute declared
 * by no registered provider is {@link com.metaobjects.ErrorCode#ERR_UNKNOWN_ATTR}. The
 * Maven goals load strict by default, so an adopter mid-migration who carries an
 * unregistered {@code @attr} (real cases: {@code @isJson}, {@code @dataflow*}) is blocked.
 * The {@code meta.lax} parameter ({@code -Dmeta.lax=true}) opts out of strict provenance so
 * the build can proceed while the metadata is reconciled.</p>
 *
 * <p>These tests drive the Mojos directly with {@code project}/{@code execution} left null
 * (so {@code createProjectClassLoader()} falls back to the test classloader), matching
 * {@link MetaDataVerifyMojoTest}.</p>
 */
public class MetaLaxStrictOptOutTest {

    /** A field carrying {@code @isJson} — an attribute declared by no registered provider. */
    private static final String UNKNOWN_ATTR_SOURCE = "mojo/lax-strict-metadata.json";

    /** A clean fixture (every attr declared) — used for the strict-flag unit assertion. */
    private static final String CLEAN_SOURCE = "mojo/verify-test-metadata.json";

    private void configure(AbstractMetaDataMojo mojo, String source) {
        LoaderParam loader = LoaderParam.builder("lax-test")
                .withClassname("com.metaobjects.loader.MetaDataLoader")
                .withSourceDir("./src/test/resources")
                .withSource(source)
                .build();
        mojo.setLoader(loader);
        // No generators: isolate the loader-creation behavior (the strict gate fires
        // in createLoader, before any generator runs).
        mojo.setGenerators(Collections.emptyList());
        mojo.setGlobals(Collections.emptyMap());
    }

    // === Behavioral: generate goal ==========================================

    @Test
    public void generateFailsByDefaultOnUnknownAttr() {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, UNKNOWN_ATTR_SOURCE);
        try {
            gen.execute();
            fail("expected the strict (default) load to fail on an unregistered @attr");
        } catch (Exception e) {
            String msg = String.valueOf(e.getMessage());
            assertTrue("failure should name the offending attribute, was: " + msg,
                    msg.contains("isJson"));
            assertTrue("failure should offer the -Dmeta.lax=true escape hatch, was: " + msg,
                    msg.contains("meta.lax"));
        }
    }

    @Test
    public void generateSucceedsWithLax() throws Exception {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, UNKNOWN_ATTR_SOURCE);
        gen.setLax(true);
        // -Dmeta.lax=true → non-strict load → the unregistered @attr is tolerated.
        gen.execute();
    }

    // === Behavioral: verify goal (same shared mojo plumbing) ================

    @Test
    public void verifyFailsByDefaultOnUnknownAttr() {
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, UNKNOWN_ATTR_SOURCE);
        try {
            verify.execute();
            fail("expected meta:verify to inherit the strict (default) gate");
        } catch (Exception e) {
            String msg = String.valueOf(e.getMessage());
            assertTrue("verify failure should name the offending attribute, was: " + msg,
                    msg.contains("isJson"));
        }
    }

    @Test
    public void verifySucceedsWithLax() throws Exception {
        MetaDataVerifyMojo verify = new MetaDataVerifyMojo();
        configure(verify, UNKNOWN_ATTR_SOURCE);
        verify.setLax(true);
        // No generators → no drift to compare; the loader is lax so it loads clean.
        verify.execute();
    }

    // === Unit: param -> LoaderOptions.isStrict() wiring =====================

    @Test
    public void laxParameterFlipsLoaderStrictFlag() {
        MetaDataGeneratorMojo strict = new MetaDataGeneratorMojo();
        configure(strict, CLEAN_SOURCE);
        MetaDataLoader strictLoader =
                strict.createLoader(strict.createProjectClassLoader());
        assertTrue("default (lax=false) must load strict",
                strictLoader.getLoaderOptions().isStrict());

        MetaDataGeneratorMojo lax = new MetaDataGeneratorMojo();
        configure(lax, CLEAN_SOURCE);
        lax.setLax(true);
        MetaDataLoader laxLoader = lax.createLoader(lax.createProjectClassLoader());
        assertFalse("-Dmeta.lax=true must load non-strict",
                laxLoader.getLoaderOptions().isStrict());
    }

    @Test(expected = MetaDataException.class)
    public void createLoaderThrowsUnderStrictForUnknownAttr() {
        MetaDataGeneratorMojo gen = new MetaDataGeneratorMojo();
        configure(gen, UNKNOWN_ATTR_SOURCE);
        // createLoader is the shared site for both goals; the strict gate fires here.
        gen.createLoader(gen.createProjectClassLoader());
    }
}
