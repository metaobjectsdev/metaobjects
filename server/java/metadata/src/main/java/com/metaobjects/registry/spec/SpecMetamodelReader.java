/*
 * Copyright 2026 Doug Mealing LLC dba Meta Objects
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
package com.metaobjects.registry.spec;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * FR-033 — the Java reader for the shared {@code spec/metamodel/*.json}
 * provider-definition files.
 *
 * <p>The 15 JSON files (one per concern provider) are the cross-port single source
 * of truth for every type / attr / common-attr <em>description</em> (+ optional
 * {@code rules}/{@code example}/{@code whenToUse}). They are byte-identical across
 * the ports by design, so each port READS them rather than hand-copying the prose —
 * the exact duplication FR-033 kills.</p>
 *
 * <p>This reader parses the embedded JSON (bundled into the jar at
 * {@code spec/metamodel/*.json} by the metadata module's {@code maven-resources-plugin}
 * copy; AOT-safe, ADR-0001 — read off the classpath, never scan an arbitrary
 * filesystem path) into an in-memory model and exposes, per {@code (type, subType)}:
 * the type description + rules/example/whenToUse, and per attr (by name) the attr
 * description (+ doc fields). The universal {@code *.*} entry's attr children are the
 * documentation common attrs.</p>
 *
 * <p><strong>Resolution honours the {@code extends} blocks.</strong> An attr declared
 * in a top-level {@code extends} directive (e.g. {@code db.json}'s {@code @column} on
 * {@code field.*}, or {@code field: [date,time,timestamp]}) applies additively to the
 * matching subtypes. {@link #attrDoc(String, String, String)} resolves a requested
 * {@code (type, subType, attrName)} by checking, in order: the exact
 * {@code types[].children} entry, then any matching {@code extends} block (exact
 * subType / {@code "*"} wildcard / list membership). This disambiguates attr names
 * that recur with different prose on different subtypes (e.g. {@code @kind},
 * {@code @objectRef}, {@code @unique}).</p>
 *
 * <p>The reader does NOT enforce or build the strict children graph / cardinality /
 * per-subtype scoping — that is sub-step B2. The model it parses (incl. structural
 * children + cardinality) is the durable foundation B2 extends; B1 uses only the
 * description-resolution surface.</p>
 */
public final class SpecMetamodelReader {

    /** Classpath directory the metadata jar embeds the spec files under. */
    public static final String EMBED_DIR = "spec/metamodel";

    /** The 15 shared provider-definition file names (keep in lockstep with {@code spec/metamodel/}). */
    public static final List<String> SPEC_FILES = List.of(
            "attr.json", "db.json", "documentation.json", "field.json", "identity.json",
            "layout.json", "object.json", "origin.json", "prompt.json", "relationship.json",
            "source.json", "template.json", "ui.json", "validator.json", "view.json");

    /** Wildcard token used in the JSON for "any type / any subType". */
    private static final String WILDCARD = "*";

    /** The abstract base subtype name (the {@code extendsBase} inheritance root per type). */
    private static final String BASE_SUBTYPE = "base";

    /**
     * One documented metamodel facet (a type/subType or an attr) — its description
     * plus the optional doc fields. Any may be {@code null} when absent in the JSON.
     */
    public record DocFacet(String description, String rules, String example, String whenToUse) {
    }

    /**
     * An attr child entry parsed from the JSON (the description-bearing facet B1 uses,
     * plus the structural cardinality fields B2 will consume).
     */
    public record AttrEntry(String name, String subType, boolean isArray,
                            Integer min, Integer max, boolean maxIsNull,
                            String description, String rules, String example, String whenToUse) {
    }

    // (type.subType) -> the type's own DocFacet
    private final Map<String, DocFacet> typeDocs = new LinkedHashMap<>();
    // (type.subType) -> attrName -> AttrEntry (from the types[].children attr entries)
    private final Map<String, Map<String, AttrEntry>> typeAttrDocs = new LinkedHashMap<>();
    // extends directives: matcher + its attr entries (applied additively to matching subtypes)
    private final List<ExtendsBlock> extendsBlocks = new ArrayList<>();
    // the universal *.* common-attr entries (the documentation vocabulary), by name
    private final Map<String, AttrEntry> commonAttrDocs = new LinkedHashMap<>();

    private record ExtendsBlock(String type, List<String> subTypes, boolean wildcardSubType,
                                Map<String, AttrEntry> attrs) {
    }

    private SpecMetamodelReader() {
    }

    /**
     * Load + parse the embedded {@code spec/metamodel/*.json} off the classpath of
     * the given loader.
     *
     * @param loader the classloader whose classpath carries the embedded files
     * @return a fully-parsed reader
     * @throws IllegalStateException if a spec file is missing or unparseable
     */
    public static SpecMetamodelReader loadFromClasspath(ClassLoader loader) {
        SpecMetamodelReader reader = new SpecMetamodelReader();
        for (String file : SPEC_FILES) {
            String resource = EMBED_DIR + "/" + file;
            try (InputStream in = loader.getResourceAsStream(resource)) {
                if (in == null) {
                    throw new IllegalStateException(
                            "FR-033: embedded spec/metamodel file missing from classpath: " + resource
                                    + " (the metadata module's maven-resources-plugin copy must bundle it).");
                }
                String json = new String(in.readAllBytes(), StandardCharsets.UTF_8);
                reader.parse(JsonParser.parseString(json).getAsJsonObject());
            } catch (IOException e) {
                throw new IllegalStateException("FR-033: failed reading embedded spec file " + resource, e);
            } catch (RuntimeException e) {
                throw new IllegalStateException("FR-033: failed parsing embedded spec file " + resource
                        + ": " + e.getMessage(), e);
            }
        }
        return reader;
    }

    /** Load using the reader's own classloader (the common case). */
    public static SpecMetamodelReader load() {
        return loadFromClasspath(SpecMetamodelReader.class.getClassLoader());
    }

    private void parse(JsonObject provider) {
        JsonArray types = provider.getAsJsonArray("types");
        if (types != null) {
            for (JsonElement el : types) {
                JsonObject t = el.getAsJsonObject();
                String type = str(t, "type");
                String subType = str(t, "subType");
                if (WILDCARD.equals(type) && WILDCARD.equals(subType)) {
                    // The universal *.* entry: its attr children are the common attrs.
                    for (AttrEntry a : parseAttrChildren(t)) {
                        commonAttrDocs.put(a.name(), a);
                    }
                    continue;
                }
                String key = key(type, subType);
                typeDocs.put(key, new DocFacet(
                        nullable(t, "description"), nullable(t, "rules"),
                        nullable(t, "example"), nullable(t, "whenToUse")));
                Map<String, AttrEntry> attrs = typeAttrDocs.computeIfAbsent(key, k -> new LinkedHashMap<>());
                for (AttrEntry a : parseAttrChildren(t)) {
                    attrs.put(a.name(), a);
                }
            }
        }

        JsonArray extendsArr = provider.getAsJsonArray("extends");
        if (extendsArr != null) {
            for (JsonElement el : extendsArr) {
                JsonObject e = el.getAsJsonObject();
                String type = str(e, "type");
                JsonElement subEl = e.get("subType");
                List<String> subTypes = new ArrayList<>();
                boolean wildcard = false;
                if (subEl != null && subEl.isJsonArray()) {
                    for (JsonElement s : subEl.getAsJsonArray()) {
                        subTypes.add(s.getAsString());
                    }
                } else if (subEl != null && !subEl.isJsonNull()) {
                    String s = subEl.getAsString();
                    if (WILDCARD.equals(s)) {
                        wildcard = true;
                    } else {
                        subTypes.add(s);
                    }
                }
                Map<String, AttrEntry> attrs = new LinkedHashMap<>();
                for (AttrEntry a : parseAttrChildren(e)) {
                    attrs.put(a.name(), a);
                }
                extendsBlocks.add(new ExtendsBlock(type, subTypes, wildcard, attrs));
            }
        }
    }

    private List<AttrEntry> parseAttrChildren(JsonObject owner) {
        List<AttrEntry> out = new ArrayList<>();
        JsonArray children = owner.getAsJsonArray("children");
        if (children == null) {
            return out;
        }
        for (JsonElement el : children) {
            JsonObject c = el.getAsJsonObject();
            if (!"attr".equals(str(c, "type"))) {
                continue; // structural child — parsed for B2; B1 reads only attr docs
            }
            Integer min = c.has("min") && !c.get("min").isJsonNull() ? c.get("min").getAsInt() : null;
            boolean maxIsNull = c.has("max") && c.get("max").isJsonNull();
            Integer max = c.has("max") && !c.get("max").isJsonNull() ? c.get("max").getAsInt() : null;
            boolean isArray = c.has("isArray") && !c.get("isArray").isJsonNull() && c.get("isArray").getAsBoolean();
            out.add(new AttrEntry(
                    str(c, "name"), nullable(c, "subType"), isArray, min, max, maxIsNull,
                    nullable(c, "description"), nullable(c, "rules"),
                    nullable(c, "example"), nullable(c, "whenToUse")));
        }
        return out;
    }

    // ------------------------------------------------------------------
    // Lookup surface (B1)
    // ------------------------------------------------------------------

    /** The {@code (type, subType)} doc facet, or {@code null} when the JSON has no such entry. */
    public DocFacet typeDoc(String type, String subType) {
        return typeDocs.get(key(type, subType));
    }

    /**
     * Resolve an attr's doc entry for a {@code (type, subType)} — checking the exact
     * {@code types[].children} entry first, then any {@code extends} block matching
     * the {@code (type, subType)} (exact / wildcard / list). {@code null} when no JSON
     * source declares this attr for this subtype.
     */
    public AttrEntry attrDoc(String type, String subType, String attrName) {
        AttrEntry exact = attrDocExact(type, subType, attrName);
        if (exact != null) {
            return exact;
        }
        // Base-subtype fallback (the JSON's extendsBase inheritance): an attr declared
        // on the abstract base subtype (e.g. field.base's @required/@default/@unique)
        // applies to every concrete subtype that extends it. Java snapshots those onto
        // each concrete subtype as named reqs, so resolve them via the base row. The
        // base subtype itself ("base") is excluded to avoid self-recursion.
        if (!BASE_SUBTYPE.equals(subType)) {
            return attrDocExact(type, BASE_SUBTYPE, attrName);
        }
        return null;
    }

    /** Resolve strictly for the given {@code (type, subType)} (exact types[] + matching extends). */
    private AttrEntry attrDocExact(String type, String subType, String attrName) {
        Map<String, AttrEntry> direct = typeAttrDocs.get(key(type, subType));
        if (direct != null) {
            AttrEntry a = direct.get(attrName);
            if (a != null) {
                return a;
            }
        }
        for (ExtendsBlock b : extendsBlocks) {
            if (!b.type().equals(type)) {
                continue;
            }
            boolean subMatches = b.wildcardSubType() || b.subTypes().contains(subType);
            if (subMatches) {
                AttrEntry a = b.attrs().get(attrName);
                if (a != null) {
                    return a;
                }
            }
        }
        return null;
    }

    /** The universal {@code *.*} common-attr doc entry by name, or {@code null}. */
    public AttrEntry commonAttrDoc(String name) {
        return commonAttrDocs.get(name);
    }

    /** All registered {@code (type.subType)} keys parsed from the JSON (debug/diagnostics). */
    public Map<String, DocFacet> allTypeDocs() {
        return Map.copyOf(typeDocs);
    }

    // ------------------------------------------------------------------

    private static String key(String type, String subType) {
        return type + "." + subType;
    }

    private static String str(JsonObject o, String k) {
        JsonElement e = o.get(k);
        return (e == null || e.isJsonNull()) ? null : e.getAsString();
    }

    private static String nullable(JsonObject o, String k) {
        return str(o, k);
    }
}
