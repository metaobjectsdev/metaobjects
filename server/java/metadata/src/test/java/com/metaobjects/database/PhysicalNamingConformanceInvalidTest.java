package com.metaobjects.database;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.metaobjects.MetaDataException;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.junit.runners.Parameterized;
import org.junit.runners.Parameterized.Parameter;
import org.junit.runners.Parameterized.Parameters;

import java.io.IOException;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;

import static org.junit.Assert.assertThrows;

/**
 * ADR-0058 — the shared physical-naming corpus's {@code invalid} array: each {@code naming}
 * block must be refused when {@code NeutralConfig} reads it, and a block with
 * {@code messageIncludes} with a message carrying each string and this port's name.
 *
 * <p>A top-level class, not a nested one: Surefire's default excludes nested classes, so the
 * {@code Invalid} suite that used to live inside {@link PhysicalNamingConformanceTest} never ran.</p>
 */
@RunWith(Parameterized.class)
public class PhysicalNamingConformanceInvalidTest extends SharedRegistryTestBase {


    @Parameters(name = "{0}")
    public static Collection<Object[]> invalidCases() throws IOException {
        PhysicalNamingConformanceTest.registerCorpusStrategies();
        JsonObject root = PhysicalNamingConformanceTest.readCorpus();
        List<Object[]> rows = new ArrayList<>();
        for (JsonElement el : root.getAsJsonArray("invalid")) {
            JsonObject c = el.getAsJsonObject();
            String name = c.get("name").getAsString();
            List<String> includes = new ArrayList<>();
            if (c.has("messageIncludes")) {
                for (JsonElement m : c.getAsJsonArray("messageIncludes")) includes.add(m.getAsString());
            }
            rows.add(new Object[]{name, new PhysicalNamingConformanceTest.InvalidCase(name, c.get("naming"), includes)});
        }
        return rows;
    }

    @Parameter(0)
    public String caseName;

    @Parameter(1)
    public PhysicalNamingConformanceTest.InvalidCase testCase;

    @Test
    public void isRefused() {
        MetaDataException ex = assertThrows(MetaDataException.class,
            () -> PhysicalNamingConformanceTest.parseNaming(testCase.naming(), "invalid-case:" + caseName));
        for (String part : testCase.messageIncludes()) {
            org.junit.Assert.assertTrue(caseName + ": message should contain " + part + ": " + ex.getMessage(),
                ex.getMessage().contains(part));
        }
        if (!testCase.messageIncludes().isEmpty()) {
            org.junit.Assert.assertTrue(ex.getMessage(), ex.getMessage().contains("Java port"));
        }
    }
}
