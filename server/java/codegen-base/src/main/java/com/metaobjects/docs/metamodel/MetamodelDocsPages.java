package com.metaobjects.docs.metamodel;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.google.gson.JsonPrimitive;
import com.metaobjects.registry.RegistryManifest;

import java.io.IOException;
import java.io.InputStream;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;

/**
 * The metamodel reference pages' data: what the shared Mustache templates
 * ({@code templates/metamodel/}) render as {@code INDEX.md}, {@code providers.md} and one
 * {@code types/<family>.md} per type family. The Java/Kotlin port of the TypeScript
 * {@code buildMetamodelDocsPages}, pinned by {@code fixtures/metamodel-docs/data/}.
 *
 * <p>Two inputs this port already holds: its registry vocabulary manifest
 * ({@link RegistryManifest#emit}, byte-matched across the ports) and its embedded copy of
 * {@code spec/metamodel/*.json}, the only place provider ownership and attr defaults live
 * (the manifest is provider-blind, ADR-0050). The builder makes every decision; a template
 * only lays the lines out. Core, not ejectable: it decides what there is to emit.</p>
 */
public final class MetamodelDocsPages {

    public static final String INDEX_PAGE_REF = "metamodel/index.md";
    public static final String PROVIDERS_PAGE_REF = "metamodel/providers.md";
    public static final String TYPE_PAGE_REF = "metamodel/type-page.md";

    /** Classpath location of the provider descriptions that ship with the templates. */
    public static final String DESCRIPTIONS_RESOURCE = "metaobjects/templates/metamodel/provider-descriptions.json";

    /** One page to render: its output path (relative), its template ref and the template's data. */
    public record Page(String path, String template, Map<String, Object> data) {}

    /** The definition files in the order TypeScript walks them (first declarer of an attr wins). */
    static final List<String> DEFINITION_FILES = List.of(
            "field", "object", "attr", "validator", "identity", "index", "relationship",
            "documentation", "origin", "source", "db", "view", "layout", "ui", "ui-web",
            "template", "prompt", "api", "transition", "view-expressions", "reporting", "requirement");

    private static final String WILDCARD = "*";
    private static final String ATTR = "attr";
    private static final String BASE = "base";
    private static final String NO_VALUE = "—";

    private MetamodelDocsPages() {
    }

    /** Every page, built from this port's own registry and embedded definitions. */
    public static List<Page> build() {
        JsonObject manifest = JsonParser.parseString(
                RegistryManifest.emit(RegistryManifest.composeMetamodelRegistry())).getAsJsonObject();
        ClassLoader loader = MetamodelDocsPages.class.getClassLoader();
        return build(manifest, embeddedDefinitions(loader), providerDescriptions(loader));
    }

    /** The embedded {@code spec/metamodel/*.json} definitions, in walking order. */
    public static List<JsonObject> embeddedDefinitions(ClassLoader loader) {
        List<JsonObject> out = new ArrayList<>();
        for (String name : DEFINITION_FILES) {
            out.add(readJson(loader, "spec/metamodel/" + name + ".json").getAsJsonObject());
        }
        return out;
    }

    /** Provider id to its one-line description. */
    public static Map<String, String> providerDescriptions(ClassLoader loader) {
        Map<String, String> out = new LinkedHashMap<>();
        for (Map.Entry<String, JsonElement> e : readJson(loader, DESCRIPTIONS_RESOURCE).getAsJsonObject().entrySet()) {
            out.put(e.getKey(), e.getValue().getAsString());
        }
        return out;
    }

    private static JsonElement readJson(ClassLoader loader, String resource) {
        try (InputStream in = loader.getResourceAsStream(resource)) {
            if (in == null) throw new IllegalStateException("metamodel docs: missing classpath resource " + resource);
            return JsonParser.parseString(new String(in.readAllBytes(), StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new IllegalStateException("metamodel docs: could not read " + resource, e);
        }
    }

    // ------------------------------------------------------------------ helpers

    private static String str(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? null : e.getAsString();
    }

    private static boolean flag(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e != null && !e.isJsonNull() && e.getAsBoolean();
    }

    private static JsonArray arr(JsonObject o, String key) {
        JsonElement e = o.get(key);
        return e == null || e.isJsonNull() ? new JsonArray() : e.getAsJsonArray();
    }

    /** Escape a markdown table cell: collapse newlines, escape pipes. */
    static String cell(String s) {
        return s.replaceAll("\\r?\\n", " ").replace("|", "\\|").strip();
    }

    /** The anchor GitHub assigns to a {@code ### field.currency} heading: {@code fieldcurrency}. */
    static String anchor(String type, String subType) {
        return (type + subType).toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }

    /** JavaScript's {@code String(v)} for a JSON scalar. */
    private static String jsString(JsonElement v) {
        if (v.isJsonPrimitive()) {
            JsonPrimitive p = v.getAsJsonPrimitive();
            if (p.isNumber()) {
                BigDecimal d = p.getAsBigDecimal();
                return d.stripTrailingZeros().scale() <= 0 ? d.toBigInteger().toString() : d.stripTrailingZeros().toPlainString();
            }
            return p.getAsString();
        }
        return v.toString();
    }

    /** A value as an inline-code token; nothing for no value. */
    private static String valueToken(JsonElement v) {
        if (v == null || v.isJsonNull()) return "";
        return "`" + jsString(v) + "`";
    }

    private static String codeList(Iterable<String> items, String prefix) {
        List<String> parts = new ArrayList<>();
        for (String i : items) parts.add("`" + prefix + i + "`");
        return String.join(", ", parts);
    }

    private static List<String> sorted(Iterable<String> items) {
        TreeSet<String> s = new TreeSet<>();
        for (String i : items) s.add(i);
        return new ArrayList<>(s);
    }

    private static boolean isUniversal(JsonObject t) {
        return WILDCARD.equals(str(t, "type")) && WILDCARD.equals(str(t, "subType"));
    }

    private static boolean isAttrChild(JsonElement c) {
        return ATTR.equals(str(c.getAsJsonObject(), "type"));
    }

    // --------------------------------------------------------------- provenance

    private record AttrProvenance(String provider, JsonElement deflt) {}

    private static final class Provenance {
        final Map<String, String> ownerOfType = new HashMap<>();
        final Map<String, AttrProvenance> attrs = new HashMap<>();
        List<String> providerIds = new ArrayList<>();
        final Map<String, Set<String>> owned = new HashMap<>();
        final Map<String, Map<String, Set<String>>> contributed = new HashMap<>();
        final Map<String, Set<String>> common = new HashMap<>();
    }

    private static Provenance buildProvenance(JsonObject manifest, List<JsonObject> definitions) {
        Set<String> covered = new HashSet<>();
        Map<String, List<String>> subTypesOf = new HashMap<>();
        for (JsonElement el : arr(manifest, "types")) {
            JsonObject t = el.getAsJsonObject();
            covered.add(str(t, "type") + "." + str(t, "subType"));
            subTypesOf.computeIfAbsent(str(t, "type"), k -> new ArrayList<>()).add(str(t, "subType"));
        }
        Provenance p = new Provenance();
        Set<String> ids = new LinkedHashSet<>();

        for (JsonObject def : definitions) {
            String id = str(def, "provider");
            if (ids.add(id)) {
                p.owned.put(id, new HashSet<>());
                p.contributed.put(id, new HashMap<>());
                p.common.put(id, new HashSet<>());
            }
            for (JsonElement el : arr(def, "types")) {
                JsonObject t = el.getAsJsonObject();
                if (isUniversal(t)) {
                    for (JsonElement c : arr(t, "children")) {
                        if (isAttrChild(c)) p.common.get(id).add(str(c.getAsJsonObject(), "name"));
                    }
                    continue;
                }
                String type = str(t, "type");
                String subType = str(t, "subType");
                String tk = type + "." + subType;
                p.ownerOfType.putIfAbsent(tk, id);
                if (covered.contains(tk)) p.owned.get(id).add(tk);
                for (JsonElement c : arr(t, "children")) {
                    if (isAttrChild(c)) record(p, id, type, subType, c.getAsJsonObject());
                }
            }
            for (JsonElement el : arr(def, "extends")) {
                JsonObject ext = el.getAsJsonObject();
                String type = str(ext, "type");
                JsonElement sub = ext.get("subType");
                List<String> subTypes = new ArrayList<>();
                if (sub.isJsonArray()) {
                    for (JsonElement s : sub.getAsJsonArray()) subTypes.add(s.getAsString());
                } else if (WILDCARD.equals(sub.getAsString())) {
                    subTypes.addAll(subTypesOf.getOrDefault(type, List.of()));
                } else {
                    subTypes.add(sub.getAsString());
                }
                for (String subType : subTypes) {
                    for (JsonElement c : arr(ext, "children")) {
                        if (isAttrChild(c)) record(p, id, type, subType, c.getAsJsonObject());
                    }
                }
            }
        }
        p.providerIds = sorted(ids);
        return p;
    }

    private static void record(Provenance p, String id, String type, String subType, JsonObject c) {
        String name = str(c, "name");
        p.attrs.putIfAbsent(type + "." + subType + "." + name, new AttrProvenance(id, c.get("default")));
        p.contributed.get(id).computeIfAbsent(type + "." + subType, k -> new HashSet<>()).add(name);
    }

    // -------------------------------------------------------------------- pages

    private static Map<String, Object> indexData(List<JsonObject> types) {
        List<Object> rows = new ArrayList<>();
        for (JsonObject t : types) {
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("typeSubType", str(t, "type") + "." + str(t, "subType"));
            row.put("description", cell(nz(str(t, "description"))));
            row.put("page", "types/" + str(t, "type") + ".md#" + anchor(str(t, "type"), str(t, "subType")));
            rows.add(row);
        }
        return Map.of("rows", rows);
    }

    private static String nz(String s) {
        return s == null ? "" : s;
    }

    private static Map<String, Object> providersData(Provenance p, Map<String, String> descriptions) {
        List<Object> providers = new ArrayList<>();
        for (String id : p.providerIds) {
            String description = descriptions.get(id);
            List<String> owned = sorted(p.owned.get(id));
            List<String> common = sorted(p.common.get(id));
            List<Object> contributes = new ArrayList<>();
            for (String tk : sorted(p.contributed.get(id).keySet())) {
                Map<String, Object> c = new LinkedHashMap<>();
                c.put("typeSubType", tk);
                c.put("attrs", codeList(sorted(p.contributed.get(id).get(tk)), "@"));
                contributes.add(c);
            }
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", id);
            m.put("hasDescription", description != null);
            if (description != null) m.put("description", description);
            m.put("hasOwns", !owned.isEmpty());
            if (!owned.isEmpty()) m.put("owns", codeList(owned, ""));
            m.put("hasUniversal", !common.isEmpty());
            if (!common.isEmpty()) m.put("universal", codeList(common, "@"));
            m.put("hasContributes", !contributes.isEmpty());
            m.put("contributes", contributes);
            providers.add(m);
        }
        return Map.of("providers", providers);
    }

    private static String childSubTypeLabel(JsonElement e) {
        if (e.isJsonArray()) {
            List<String> parts = new ArrayList<>();
            for (JsonElement s : e.getAsJsonArray()) parts.add(s.getAsString());
            return String.join(", ", parts);
        }
        return e.getAsString();
    }

    private static String childLine(JsonObject rule) {
        String childName = str(rule, "childName");
        String nameSuffix = WILDCARD.equals(childName) ? "" : " (name `" + childName + "`)";
        JsonElement minEl = rule.get("min");
        String min = minEl == null || minEl.isJsonNull() ? "0" : jsString(minEl);
        JsonElement maxEl = rule.get("max");
        String max = maxEl == null || maxEl.isJsonNull() ? "*" : jsString(maxEl);
        return "`" + str(rule, "childType") + "." + childSubTypeLabel(rule.get("childSubType")) + "`"
                + nameSuffix + " — " + min + ".." + max;
    }

    private static Map<String, Object> sectionData(JsonObject t, Provenance p, Set<String> commonAttrNames) {
        String type = str(t, "type");
        String subType = str(t, "subType");
        String owner = p.ownerOfType.get(type + "." + subType);

        List<Object> attrs = new ArrayList<>();
        for (JsonElement el : arr(t, "attrs")) {
            JsonObject a = el.getAsJsonObject();
            String name = str(a, "name");
            if (commonAttrNames.contains(name)) continue;
            // An attr inherited from `<type>.base` is recorded against the BASE in the
            // definitions, not the concrete subtype, so fall back to the base.
            AttrProvenance prov = p.attrs.get(type + "." + subType + "." + name);
            if (prov == null) prov = p.attrs.get(type + "." + BASE + "." + name);
            List<String> allowed = new ArrayList<>();
            for (JsonElement v : arr(a, "allowedValues")) allowed.add(valueToken(v));
            JsonElement vt = a.get("valueType");
            String scalar = vt == null || vt.isJsonNull() ? "any" : vt.getAsString();
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("name", name);
            row.put("type", flag(a, "isArray") ? scalar + "[]" : scalar);
            row.put("required", flag(a, "required") ? "yes" : "no");
            row.put("default", prov == null ? "" : valueToken(prov.deflt()));
            row.put("allowed", String.join(", ", allowed));
            row.put("provider", prov == null ? NO_VALUE : prov.provider());
            row.put("description", cell(nz(str(a, "description"))));
            attrs.add(row);
        }
        List<Object> children = new ArrayList<>();
        for (JsonElement el : arr(t, "children")) {
            JsonObject c = el.getAsJsonObject();
            if (ATTR.equals(str(c, "childType"))) continue;
            children.add(childLine(c));
        }
        List<String> implementedIn = new ArrayList<>();
        for (JsonElement e : arr(t, "implementedIn")) implementedIn.add(e.getAsString());
        implementedIn = sorted(implementedIn);
        List<String> parents = new ArrayList<>();
        for (JsonElement e : arr(t, "parents")) parents.add(e.getAsString());
        parents = sorted(parents);

        Map<String, Object> m = new LinkedHashMap<>();
        m.put("typeSubType", type + "." + subType);
        m.put("description", nz(str(t, "description")));
        m.put("hasOwner", owner != null);
        if (owner != null) m.put("owner", owner);
        m.put("hasImplementedIn", !implementedIn.isEmpty());
        if (!implementedIn.isEmpty()) m.put("implementedIn", String.join(", ", implementedIn));
        for (String[] k : new String[][] {{"rules", "hasRules"}, {"whenToUse", "hasWhenToUse"}, {"example", "hasExample"}}) {
            String v = str(t, k[0]);
            m.put(k[1], v != null);
            if (v != null) m.put(k[0], v);
        }
        m.put("hasAttrs", !attrs.isEmpty());
        m.put("attrs", attrs);
        m.put("hasChildren", !children.isEmpty());
        m.put("children", children);
        m.put("hasParents", !parents.isEmpty());
        if (!parents.isEmpty()) m.put("parents", codeList(parents, ""));
        return m;
    }

    /**
     * Every metamodel reference page, in output order: {@code INDEX.md}, {@code providers.md},
     * then one {@code types/<family>.md} per type family, sorted. Documentation (common) attrs
     * are left off the type pages and listed once on the providers page.
     */
    public static List<Page> build(JsonObject manifest, List<JsonObject> definitions,
                                   Map<String, String> providerDescriptions) {
        Provenance p = buildProvenance(manifest, definitions);
        Set<String> commonAttrNames = new HashSet<>();
        for (JsonElement e : arr(manifest, "commonAttrs")) commonAttrNames.add(str(e.getAsJsonObject(), "name"));
        List<JsonObject> types = new ArrayList<>();
        for (JsonElement e : arr(manifest, "types")) types.add(e.getAsJsonObject());

        List<Page> pages = new ArrayList<>();
        pages.add(new Page("INDEX.md", INDEX_PAGE_REF, indexData(types)));
        pages.add(new Page("providers.md", PROVIDERS_PAGE_REF, providersData(p, providerDescriptions)));
        Map<String, List<JsonObject>> byFamily = new LinkedHashMap<>();
        for (JsonObject t : types) byFamily.computeIfAbsent(str(t, "type"), k -> new ArrayList<>()).add(t);
        for (String family : sorted(byFamily.keySet())) {
            List<Object> sections = new ArrayList<>();
            for (JsonObject t : byFamily.get(family)) sections.add(sectionData(t, p, commonAttrNames));
            Map<String, Object> data = new LinkedHashMap<>();
            data.put("family", family);
            data.put("sections", sections);
            pages.add(new Page("types/" + family + ".md", TYPE_PAGE_REF, data));
        }
        return pages;
    }
}
