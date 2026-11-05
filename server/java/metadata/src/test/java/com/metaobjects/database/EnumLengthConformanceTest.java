package com.metaobjects.database;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.metaobjects.ErrorCode;
import com.metaobjects.MetaDataException;
import com.metaobjects.config.EnumDefaults;
import com.metaobjects.config.NeutralConfig;
import com.metaobjects.field.MetaField;
import com.metaobjects.loader.FileSource;
import com.metaobjects.loader.LoaderOptions;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;
import com.metaobjects.registry.SharedRegistryTestBase;
import org.junit.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.List;
import java.util.Map;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

/**
 * The shared cross-port enum-length corpus ({@code fixtures/enum-length-conformance/}) run
 * against the Java port: each case's {@code enums} block parsed with {@link NeutralConfig}
 * (the reader every project-aware load uses), put on the loaded {@code meta.enums.json} root,
 * and every Ticket enum's column length resolved through {@link EnumLength#resolveMaxLength}.
 * Each {@code overflow} case is refused with {@code ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH}, and
 * each {@code invalid} block when the config is read.
 */
public class EnumLengthConformanceTest extends SharedRegistryTestBase {

    private static Path corpusDir() {
        Path dir = Paths.get("").toAbsolutePath();
        while (dir != null && !Files.isDirectory(dir.resolve("fixtures"))) dir = dir.getParent();
        if (dir == null) throw new IllegalStateException("could not locate the repository fixtures/ directory");
        return dir.resolve("fixtures/enum-length-conformance");
    }

    private static JsonObject corpus() throws IOException {
        return JsonParser.parseString(new String(
            Files.readAllBytes(corpusDir().resolve("cases.json")), StandardCharsets.UTF_8)).getAsJsonObject();
    }

    private static EnumDefaults parseEnums(JsonElement enums) {
        JsonObject doc = new JsonObject();
        doc.addProperty("schema_version", 1);
        if (enums != null && !enums.isJsonNull()) doc.add("enums", enums);
        return NeutralConfig.parse(doc.toString(), "enum-length-corpus").getEnumDefaults();
    }

    private MetaField<?> ticketField(EnumDefaults defaults, String name) throws IOException {
        MetaDataLoader loader = new MetaDataLoader(
            LoaderOptions.create(false, false, true), MetaDataLoader.SUBTYPE_MANUAL, "enum_length_conformance");
        loader.init();
        loader.load(List.of(new FileSource(corpusDir().resolve("meta.enums.json"))));
        if (!loader.getErrors().isEmpty()) fail("expected a clean load, got: " + loader.getErrors());
        loader.getRoot().setEnumDefaults(defaults);
        for (MetaObject obj : loader.getMetaObjects()) {
            if (obj.getShortName().equals("Ticket")) return obj.getMetaField(name);
        }
        throw new AssertionError("no Ticket in the corpus model");
    }

    @Test
    public void resolvesEveryEnumColumnLength() throws IOException {
        for (JsonElement el : corpus().getAsJsonArray("cases")) {
            JsonObject c = el.getAsJsonObject();
            EnumDefaults defaults = parseEnums(c.get("enums"));
            for (Map.Entry<String, JsonElement> e : c.getAsJsonObject("lengths").entrySet()) {
                Long expected = e.getValue().isJsonNull() ? null : e.getValue().getAsLong();
                assertEquals(c.get("name").getAsString() + ": " + e.getKey(),
                    expected, EnumLength.resolveMaxLength(ticketField(defaults, e.getKey())));
            }
        }
    }

    @Test
    public void refusesAMemberLongerThanTheProjectDefault() throws IOException {
        for (JsonElement el : corpus().getAsJsonArray("overflow")) {
            JsonObject o = el.getAsJsonObject();
            MetaField<?> field = ticketField(parseEnums(o.get("enums")), o.get("field").getAsString());
            try {
                EnumLength.resolveMaxLength(field);
                fail(o.get("name").getAsString() + ": expected a refusal");
            } catch (MetaDataException e) {
                assertEquals(java.util.Optional.of(ErrorCode.ERR_ENUM_VALUE_EXCEEDS_MAX_LENGTH), e.getCode());
                assertTrue(e.getMessage(), e.getMessage().contains(o.get("member").getAsString()));
            }
        }
    }

    @Test
    public void refusesAnInvalidEnumsBlock() throws IOException {
        for (JsonElement el : corpus().getAsJsonArray("invalid")) {
            JsonObject bad = el.getAsJsonObject();
            try {
                parseEnums(bad.get("enums"));
                fail(bad.get("name").getAsString() + ": expected the config to be refused");
            } catch (MetaDataException expected) {
                // refused when read
            }
        }
    }
}
