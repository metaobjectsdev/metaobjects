package com.metaobjects.conformance;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.metaobjects.MetaData;
import com.metaobjects.field.MetaField;
import com.metaobjects.identity.MetaIdentity;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.List;
import java.util.TreeSet;

/**
 * Minimal operation-script evaluator for the cross-port conformance corpus.
 *
 * <p>Mirrors the TS / C# script harnesses. Supports a tiny op vocabulary that
 * the corpus exercises today:</p>
 * <ul>
 *   <li>{@code navigate: ["object:<name>"]} — select a root-level
 *       {@link MetaObject} by its short name.</li>
 *   <li>{@code invoke: "object.effective-fields"} — names of fields including
 *       inherited (super chain).</li>
 *   <li>{@code invoke: "object.own-fields"} — names of own fields only.</li>
 *   <li>{@code invoke: "object.find-field" args: {name: ...}} — returns
 *       {@code {name: ...}} when present, {@code {absent: true}} when not.</li>
 *   <li>{@code invoke: "object.primary-identity"} — returns the primary
 *       identity's {@code subtype}.</li>
 * </ul>
 */
final class ScriptRunner {

    private ScriptRunner() {}

    static void run(MetaDataLoader loader, JsonElement scriptEl, List<String> failures) {
        if (loader == null || scriptEl == null || !scriptEl.isJsonObject()) {
            failures.add("script.json: top-level must be a JSON object with an 'operations' array");
            return;
        }
        JsonObject scriptObj = scriptEl.getAsJsonObject();
        JsonElement opsEl = scriptObj.get("operations");
        if (opsEl == null || !opsEl.isJsonArray()) {
            failures.add("script.json: missing 'operations' array");
            return;
        }
        int i = 0;
        for (JsonElement opEl : opsEl.getAsJsonArray()) {
            i++;
            if (!opEl.isJsonObject()) {
                failures.add("script.json op #" + i + ": each operation must be a JSON object");
                continue;
            }
            runOperation(loader, opEl.getAsJsonObject(), i, failures);
        }
    }

    private static void runOperation(MetaDataLoader loader, JsonObject op,
                                      int index, List<String> failures) {
        MetaData target = navigate(loader, op.get("navigate"), index, failures);
        if (target == null) return;

        String invoke = op.has("invoke") && op.get("invoke").isJsonPrimitive()
            ? op.get("invoke").getAsString() : null;
        if (invoke == null) {
            failures.add("script.json op #" + index + ": missing 'invoke'");
            return;
        }
        JsonObject args = op.has("args") && op.get("args").isJsonObject()
            ? op.get("args").getAsJsonObject() : null;
        JsonObject expect = op.has("expect") && op.get("expect").isJsonObject()
            ? op.get("expect").getAsJsonObject() : null;
        if (expect == null) {
            failures.add("script.json op #" + index + ": missing 'expect'");
            return;
        }

        switch (invoke) {
            case "object.effective-fields": {
                MetaObject obj = requireObject(target, index, invoke, failures);
                if (obj == null) return;
                assertNames(obj.getChildren(MetaField.class, true), expect, index, invoke, failures);
                return;
            }
            case "object.own-fields": {
                MetaObject obj = requireObject(target, index, invoke, failures);
                if (obj == null) return;
                assertNames(obj.getChildren(MetaField.class, false), expect, index, invoke, failures);
                return;
            }
            case "object.find-field": {
                MetaObject obj = requireObject(target, index, invoke, failures);
                if (obj == null) return;
                String name = args != null && args.has("name") && args.get("name").isJsonPrimitive()
                    ? args.get("name").getAsString() : null;
                if (name == null) {
                    failures.add("script.json op #" + index + ": object.find-field requires args.name");
                    return;
                }
                MetaField match = null;
                for (MetaField f : obj.getChildren(MetaField.class, true)) {
                    if (name.equals(f.getShortName())) { match = f; break; }
                }
                if (expect.has("absent") && expect.get("absent").getAsBoolean()) {
                    if (match != null) {
                        failures.add("script.json op #" + index + " find-field '" + name
                            + "': expected absent, got " + match.getShortName());
                    }
                } else if (expect.has("name")) {
                    if (match == null) {
                        failures.add("script.json op #" + index + " find-field '" + name
                            + "': expected to find a field, got absent");
                    } else if (!match.getShortName().equals(expect.get("name").getAsString())) {
                        failures.add("script.json op #" + index + " find-field '" + name
                            + "': expected name '" + expect.get("name").getAsString()
                            + "', got '" + match.getShortName() + "'");
                    }
                }
                return;
            }
            case "object.primary-identity": {
                MetaObject obj = requireObject(target, index, invoke, failures);
                if (obj == null) return;
                MetaIdentity primary = null;
                for (MetaData c : obj.getChildren(MetaData.class, true)) {
                    if (c instanceof MetaIdentity
                            && MetaIdentity.SUBTYPE_PRIMARY.equals(c.getSubType())) {
                        primary = (MetaIdentity) c;
                        break;
                    }
                }
                if (primary == null) {
                    failures.add("script.json op #" + index + " primary-identity: expected a primary identity, none found");
                    return;
                }
                if (expect.has("subtype")
                        && !primary.getSubType().equals(expect.get("subtype").getAsString())) {
                    failures.add("script.json op #" + index + " primary-identity: expected subtype '"
                        + expect.get("subtype").getAsString() + "', got '" + primary.getSubType() + "'");
                }
                return;
            }
            default:
                failures.add("script.json op #" + index + ": unsupported invoke '" + invoke + "'");
        }
    }

    private static MetaData navigate(MetaDataLoader loader, JsonElement navEl,
                                      int index, List<String> failures) {
        if (navEl == null || !navEl.isJsonArray()) {
            failures.add("script.json op #" + index + ": 'navigate' must be a JSON array");
            return null;
        }
        MetaData current = loader.getRoot();
        for (JsonElement step : navEl.getAsJsonArray()) {
            if (!step.isJsonPrimitive() || !step.getAsJsonPrimitive().isString()) {
                failures.add("script.json op #" + index + " navigate step must be a string");
                return null;
            }
            String s = step.getAsString();
            int colon = s.indexOf(':');
            if (colon < 1) {
                failures.add("script.json op #" + index + " navigate step '" + s
                    + "' must be of form '<kind>:<name>'");
                return null;
            }
            String kind = s.substring(0, colon);
            String name = s.substring(colon + 1);
            if ("object".equals(kind)) {
                MetaData found = null;
                for (MetaData c : current.getChildren(MetaData.class, false)) {
                    if (c instanceof MetaObject && name.equals(c.getShortName())) {
                        found = c; break;
                    }
                }
                if (found == null) {
                    failures.add("script.json op #" + index + " navigate: no object named '"
                        + name + "' at " + current);
                    return null;
                }
                current = found;
            } else {
                failures.add("script.json op #" + index + " navigate: unsupported kind '" + kind + "'");
                return null;
            }
        }
        return current;
    }

    private static MetaObject requireObject(MetaData target, int index, String invoke,
                                             List<String> failures) {
        if (target instanceof MetaObject) return (MetaObject) target;
        failures.add("script.json op #" + index + " " + invoke
            + ": navigation target is not a MetaObject");
        return null;
    }

    private static void assertNames(List<MetaField> fields, JsonObject expect,
                                     int index, String invoke, List<String> failures) {
        if (!expect.has("names") || !expect.get("names").isJsonArray()) {
            failures.add("script.json op #" + index + " " + invoke
                + ": expect.names must be a JSON array");
            return;
        }
        List<String> got = new ArrayList<>();
        for (MetaField f : fields) got.add(f.getShortName());
        List<String> want = new ArrayList<>();
        for (JsonElement el : expect.get("names").getAsJsonArray()) want.add(el.getAsString());
        // Use multiset equality (order-insensitive) — corpus does not pin ordering.
        if (!new TreeSet<>(got).equals(new TreeSet<>(want))) {
            failures.add("script.json op #" + index + " " + invoke
                + ": expected names " + want + ", got " + got);
        }
    }
}
