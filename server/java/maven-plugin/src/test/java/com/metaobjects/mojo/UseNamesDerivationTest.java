package com.metaobjects.mojo;

import com.metaobjects.generator.EmitsPhysicalNameConstants;
import com.metaobjects.generator.Generator;
import com.metaobjects.loader.MetaDataLoader;
import org.junit.Before;
import org.junit.Test;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

/**
 * NO MAGIC STRINGS — the mojo is the JVM's runner-level aggregation point, and this pins
 * that it actually aggregates.
 *
 * <p>A generator cannot answer "will {@code <Entity>Names} exist alongside my output?" on
 * its own, so the JVM ports' constant substitution shipped behind {@code useNames},
 * defaulting OFF, with a comment stating the JVM had "no runner aggregating markers". It
 * does — {@link AbstractMetaDataMojo#buildGenerators} builds the WHOLE suite before
 * configuring any of it. These tests hold that seam open: without them the derivation
 * could be dropped and every JVM generator would silently go back to literals with no test
 * failing, because each generator's own unit tests construct it directly and never reach
 * this code path.</p>
 */
public class UseNamesDerivationTest {

    /** Records the args the mojo hands it, so the derivation is observable. */
    public static class RecordingGenerator implements Generator {
        static final List<Map<String, String>> SEEN = new ArrayList<>();

        @Override public Generator setArgs(Map<String, String> args) { SEEN.add(args); return this; }
        @Override public Generator setFilters(List<String> filters) { return this; }
        @Override public Generator setScripts(List<String> scripts) { return this; }
        @Override public void execute(MetaDataLoader loader) { }
    }

    /** The same, but declaring that it EMITS the names artifact. */
    public static class RecordingNamesGenerator extends RecordingGenerator
            implements EmitsPhysicalNameConstants { }

    private MetaDataGeneratorMojo mojo;

    @Before
    public void setUp() {
        RecordingGenerator.SEEN.clear();
        mojo = new MetaDataGeneratorMojo();
        // buildGenerators reads loaderConfig.getFilters(); a bare param is enough.
        mojo.setLoader(new LoaderParam());
    }

    private static GeneratorParam param(Class<?> impl, Map<String, String> args) {
        GeneratorParam p = new GeneratorParam();
        p.setClassname(impl.getName());
        if (args != null) p.setArgs(args);
        return p;
    }

    private List<Map<String, String>> run(GeneratorParam... params) {
        mojo.setGenerators(List.of(params));
        mojo.buildGenerators(getClass().getClassLoader(), null);
        return RecordingGenerator.SEEN;
    }

    @Test
    public void a_names_generator_in_the_run_turns_useNames_on_for_every_generator() {
        List<Map<String, String>> seen = run(
                param(RecordingGenerator.class, null),
                param(RecordingNamesGenerator.class, null));

        assertEquals(2, seen.size());
        // EVERY generator, not just the ones that happen to consume it today: the flag says
        // what the RUN contains, so a generator that starts referencing constants later
        // needs no further wiring.
        for (Map<String, String> args : seen) {
            assertEquals("true", args.get(EmitsPhysicalNameConstants.ARG_USE_NAMES));
        }
    }

    @Test
    public void a_run_without_one_leaves_useNames_off_so_the_output_still_compiles() {
        // The failure this prevents is not a wrong string — it is generated code referencing
        // a type nothing generated. Falling back to literals is the correct answer here.
        List<Map<String, String>> seen = run(param(RecordingGenerator.class, null));

        assertEquals(1, seen.size());
        assertEquals("false", seen.get(0).get(EmitsPhysicalNameConstants.ARG_USE_NAMES));
    }

    @Test
    public void an_explicit_pom_value_wins_over_the_derivation() {
        // A project that has deliberately pinned the flag (to keep a golden byte-identical,
        // say) is not overridden by a derivation.
        Map<String, String> pinned = new HashMap<>();
        pinned.put(EmitsPhysicalNameConstants.ARG_USE_NAMES, "false");

        List<Map<String, String>> seen = run(
                param(RecordingGenerator.class, pinned),
                param(RecordingNamesGenerator.class, null));

        assertEquals(2, seen.size());
        assertEquals("false", seen.get(0).get(EmitsPhysicalNameConstants.ARG_USE_NAMES));
        // ...and only for the generator that pinned it.
        assertEquals("true", seen.get(1).get(EmitsPhysicalNameConstants.ARG_USE_NAMES));
    }

    @Test
    public void an_empty_suite_configures_nothing() {
        mojo.setGenerators(List.of());
        assertEquals(0, mojo.buildGenerators(getClass().getClassLoader(), null).size());
        assertEquals(0, RecordingGenerator.SEEN.size());
    }

    @Test
    public void a_null_suite_configures_nothing() {
        // getGenerators() is null when the pom declares no <generators> block at all.
        assertNull(mojo.getGenerators());
        assertEquals(0, mojo.buildGenerators(getClass().getClassLoader(), null).size());
    }
}
