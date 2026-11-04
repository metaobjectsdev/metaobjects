package com.metaobjects.generator.spring;

import com.metaobjects.loader.MetaDataLoader;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Entity-scoped cross-field validators render as class-level {@code @AssertTrue} rules on the
 * full {@code <Entity>Dto} only; the partial {@code <Entity>Patch} is unchanged (a partial body
 * cannot see the merged row, so the DB CHECK stays the enforcement there). The behavioral
 * verdicts are gated by {@code ValidationConformanceTest} against the shared corpus.
 */
public class SpringCrossFieldValidationTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static String model(boolean withValidators) {
        String validators = withValidators ? """
            , { "validator.comparison":   { "name": "startsBeforeEnds", "@left": "startsAt", "@op": "lte", "@right": "endsAt" } },
              { "validator.requiredWhen": { "name": "birthNeedsSubject", "@field": "subject", "@when": "kind", "@equals": "BIRTH" } },
              { "validator.presentIff":   { "name": "closedIffNote", "@field": "note", "@when": "kind", "@equals": "CLOSED" } },
              { "validator.atLeastOne":   { "name": "reachable", "@fields": ["subject", "note"] } },
              { "validator.requiredWhen": { "name": "ghost", "@field": "nope", "@when": "kind", "@equals": "X" } }
            """ : "";
        return """
            { "metadata.root": { "package": "acme::ev", "children": [
              { "object.entity": { "name": "Ev", "children": [
                { "source.rdb":   { "@table": "evs" } },
                { "field.long":   { "name": "id" } },
                { "field.int":    { "name": "startsAt" } },
                { "field.int":    { "name": "endsAt" } },
                { "field.string": { "name": "kind" } },
                { "field.string": { "name": "subject" } },
                { "field.string": { "name": "note" } },
                { "identity.primary": { "name": "id", "@fields": "id", "@generation": "increment" } }
                """ + validators + """
              ]}}
            ]}}
            """;
    }

    private String gen(boolean withValidators, String file) throws Exception {
        MetaDataLoader loader = SpringTestFixtures.loadFixture(
            tmp.newFolder().toPath(), "ev", model(withValidators));
        Path out = tmp.newFolder().toPath();
        SpringDtoGenerator g = new SpringDtoGenerator();
        g.setArgs(Map.of("outputDir", out.toString()));
        g.execute(loader);
        return Files.readString(out.resolve("acme/ev/" + file));
    }

    @Test
    public void dtoCarriesOneAssertTruePerValidatorAndSkipsUnresolvable() throws Exception {
        String dto = gen(true, "EvDto.java");
        assertTrue(dto, dto.contains("import jakarta.validation.constraints.*;"));
        for (String m : new String[] { "isStartsBeforeEndsValid", "isBirthNeedsSubjectValid",
                                       "isClosedIffNoteValid", "isReachableValid" }) {
            assertTrue(m + " missing:\n" + dto, dto.contains("public boolean " + m + "()"));
        }
        assertFalse("validator naming a missing field is skipped:\n" + dto, dto.contains("isGhostValid"));
        assertTrue("kept off the wire:\n" + dto,
            dto.contains("@com.fasterxml.jackson.annotation.JsonIgnore"));
        assertTrue(dto, dto.contains("this.startsAt == null || this.endsAt == null"));
    }

    @Test
    public void patchIsUnchangedByCrossFieldValidators() throws Exception {
        String withV = gen(true, "EvPatch.java");
        String without = gen(false, "EvPatch.java");
        assertTrue("PATCH body must not change", withV.equals(without));
        assertFalse(withV, withV.contains("AssertTrue"));
    }

    @Test
    public void entityWithoutCrossFieldValidatorsEmitsNoAssertTrue() throws Exception {
        String dto = gen(false, "EvDto.java");
        assertFalse(dto, dto.contains("AssertTrue"));
    }
}
