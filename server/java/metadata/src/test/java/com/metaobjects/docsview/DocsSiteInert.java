package com.metaobjects.docsview;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The line the {@code docs-site} generator is held to by the codegen-noop inert tests (the same
 * line TypeScript's {@code rules-inert.test.ts} draws). The explorer documents every node of the
 * model, so a model that declares more vocabulary gets more nodes in the docs view. Nothing else
 * may move: the app files are byte-identical, no node goes away, every new node is of a type the
 * vocabulary declares (whole nodes, or members of a node both models have), and every node both
 * models have keeps its claims and its references both ways, gaining one only from what is new.
 *
 * <p>The Java and Kotlin rules and reporting inert tests all call {@link #check}.</p>
 */
public final class DocsSiteInert {

    private DocsSiteInert() {}

    /** The stable name both JVM registries list the generator under. */
    public static final String GENERATOR = "docs-site";

    /** The files that carry the docs view and so may differ: the view, its data script, its stamp. */
    public static final List<String> PAYLOAD = List.of("explorer.json", "explorer-model.js", "explorer-stamp.js");

    /**
     * What breaks the line, one entry per problem; empty when it holds.
     *
     * @param without  the generator's files for the model without the vocabulary, by relative path
     * @param with     the same for the model with it
     * @param newTypes the types the added vocabulary may contribute, as nodes or members ({@code type})
     */
    public static List<String> check(Map<String, String> without, Map<String, String> with, Set<String> newTypes) {
        List<String> problems = new ArrayList<>();
        if (!without.keySet().equals(with.keySet())) {
            problems.add("docs-site: emitted file set " + without.keySet() + " became " + with.keySet());
            return problems;
        }
        String viewPath = null;
        for (String path : without.keySet()) {
            if (path.endsWith("/" + PAYLOAD.get(0)) || path.equals(PAYLOAD.get(0))) viewPath = path;
            if (PAYLOAD.stream().anyMatch(p -> path.equals(p) || path.endsWith("/" + p))) continue;
            if (!without.get(path).equals(with.get(path))) problems.add("docs-site: " + path + " differs");
        }
        if (viewPath == null) {
            problems.add("docs-site: no explorer.json in " + without.keySet());
            return problems;
        }
        Map<String, JsonObject> before = nodes(without.get(viewPath));
        Map<String, JsonObject> after = nodes(with.get(viewPath));
        // What the vocabulary added: whole nodes, and members of nodes both models have.
        Set<String> added = new LinkedHashSet<>();
        for (String id : before.keySet()) if (!after.containsKey(id)) problems.add("docs-site: node " + id + " went away");
        for (Map.Entry<String, JsonObject> e : after.entrySet()) {
            JsonObject n0 = before.get(e.getKey());
            if (n0 == null) {
                added.add(e.getKey());
                requireType(problems, "node " + e.getKey(), e.getValue(), newTypes);
                continue;
            }
            Map<String, JsonObject> m0 = members(n0);
            Map<String, JsonObject> m1 = members(e.getValue());
            for (String id : m0.keySet()) if (!m1.containsKey(id)) problems.add("docs-site: member " + id + " went away");
            for (Map.Entry<String, JsonObject> m : m1.entrySet()) {
                if (m0.containsKey(m.getKey())) continue;
                added.add(m.getKey());
                requireType(problems, "member " + m.getKey(), m.getValue(), newTypes);
            }
        }
        if (added.isEmpty()) problems.add("docs-site: the view gained no node or member, so the model pair proves nothing");
        for (Map.Entry<String, JsonObject> e : before.entrySet()) {
            JsonObject n1 = after.get(e.getKey());
            if (n1 == null) continue;
            JsonObject n0 = e.getValue();
            if (!n0.get("claims").equals(n1.get("claims"))) problems.add("docs-site: node " + e.getKey() + " changed its claims");
            gainedOnlyFromAdded(problems, e.getKey(), "refs", n0, n1, added);
            gainedOnlyFromAdded(problems, e.getKey(), "referencedBy", n0, n1, added);
        }
        return problems;
    }

    private static void requireType(List<String> problems, String what, JsonObject n, Set<String> newTypes) {
        String type = n.get("type").getAsString();
        if (!newTypes.contains(type)) problems.add("docs-site: new " + what + " is a " + type + ", not one of " + newTypes);
    }

    /**
     * {@code key}'s entries on {@code n1} keep every one {@code n0} had, and each new one comes
     * from an added node ({@code from}) or an added member ({@code via}).
     */
    private static void gainedOnlyFromAdded(List<String> problems, String id, String key, JsonObject n0, JsonObject n1,
                                            Set<String> added) {
        JsonArray was = n0.getAsJsonArray(key);
        JsonArray is = n1.getAsJsonArray(key);
        for (JsonElement r : was) if (!is.contains(r)) problems.add("docs-site: node " + id + " lost one of its " + key + ": " + r);
        for (JsonElement r : is) {
            if (was.contains(r)) continue;
            JsonObject ref = r.getAsJsonObject();
            if (!(added.contains(linkId(ref.get("from"))) || added.contains(linkId(ref.get("via"))))) {
                problems.add("docs-site: node " + id + " gained one of its " + key + " from nothing new: " + r);
            }
        }
    }

    private static String linkId(JsonElement link) {
        return link != null && link.isJsonObject() && link.getAsJsonObject().has("id") ? link.getAsJsonObject().get("id").getAsString() : null;
    }

    /** Every member of a node, nested ones included, by id. */
    private static Map<String, JsonObject> members(JsonObject n) {
        Map<String, JsonObject> out = new LinkedHashMap<>();
        if (!n.has("memberGroups")) return out;
        for (JsonElement g : n.getAsJsonArray("memberGroups")) {
            for (JsonElement m : g.getAsJsonObject().getAsJsonArray("members")) {
                out.put(m.getAsJsonObject().get("id").getAsString(), m.getAsJsonObject());
                out.putAll(members(m.getAsJsonObject()));
            }
        }
        return out;
    }

    private static Map<String, JsonObject> nodes(String view) {
        Map<String, JsonObject> out = new LinkedHashMap<>();
        for (JsonElement n : JsonParser.parseString(view).getAsJsonObject().getAsJsonArray("nodes")) {
            out.put(n.getAsJsonObject().get("id").getAsString(), n.getAsJsonObject());
        }
        return out;
    }
}
