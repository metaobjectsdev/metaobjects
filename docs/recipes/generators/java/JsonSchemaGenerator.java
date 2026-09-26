// EXAMPLE GENERATOR — copy into your codegen Maven module (the one `mvn metaobjects:eject`
// scaffolds, or any module the metaobjects-maven-plugin has as a <dependency>) and own it.
// A worked example, NOT a supported MetaObjects product surface: no release promises its output.
//
// Wire it in the pom that runs metaobjects:generate:
//   <generator>
//     <classname>com.acme.codegen.JsonSchemaGenerator</classname>
//     <args><outputDir>${project.basedir}/src/main/resources/schemas</outputDir></args>
//   </generator>
// `mvn metaobjects:verify` re-runs it into a temp dir and fails on drift; nothing to register.
//
// Emits <Name>.schema.json (JSON Schema 2020-12) per concrete object.
package com.acme.codegen;

import com.metaobjects.field.MetaField;
import com.metaobjects.generator.FileEmittingGenerator;
import com.metaobjects.generator.ModelWalk;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

public class JsonSchemaGenerator extends FileEmittingGenerator {

    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        List<EmittedFile> out = new ArrayList<>();
        // concreteObjects: abstract bases only contribute fields to what extends them.
        for (MetaObject obj : ModelWalk.concreteObjects(loader)) {
            Map<String, Object> schema = new LinkedHashMap<>();
            schema.put("$schema", "https://json-schema.org/draft/2020-12/schema");
            schema.putAll(objectSchema(obj, t -> "./" + ModelWalk.name(t) + ".schema.json"));
            // ModelWalk.name, not getName(): getName() is the FQN "shop::Customer".
            out.add(new EmittedFile(ModelWalk.name(obj) + ".schema.json", json(schema, "") + "\n"));
        }
        return out;
    }

    public static Map<String, Object> objectSchema(MetaObject obj, java.util.function.Function<MetaObject, String> refFor) {
        Map<String, Object> props = new LinkedHashMap<>();
        List<String> required = new ArrayList<>();
        // ModelWalk.fields RESOLVES: an entity that `extends` a base gets its fields too.
        for (MetaField f : ModelWalk.fields(obj)) {
            props.put(f.getName(), fieldSchema(f, refFor));
            if (ModelWalk.isRequired(f)) required.add(f.getName());
        }
        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("title", ModelWalk.name(obj));
        schema.put("type", "object");
        schema.put("properties", props);
        if (!required.isEmpty()) schema.put("required", required);
        String description = ModelWalk.description(obj);
        if (description != null) schema.put("description", description);
        return schema;
    }

    public static Map<String, Object> fieldSchema(MetaField f, java.util.function.Function<MetaObject, String> refFor) {
        Map<String, Object> v = new LinkedHashMap<>();
        switch (f.getSubType()) {
            case "int", "long", "currency" -> v.put("type", "integer");
            case "double", "float" -> v.put("type", "number");
            case "decimal" -> { v.put("type", "string"); v.put("pattern", "^-?\\d+(\\.\\d+)?$"); }
            case "boolean" -> v.put("type", "boolean");
            case "date" -> { v.put("type", "string"); v.put("format", "date"); }
            case "time" -> { v.put("type", "string"); v.put("format", "time"); }
            case "timestamp" -> { v.put("type", "string"); v.put("format", "date-time"); }
            case "uuid" -> { v.put("type", "string"); v.put("format", "uuid"); }
            case "enum" -> { v.put("type", "string"); v.put("enum", ModelWalk.enumValues(f)); }
            case "object" -> {
                MetaObject target = ModelWalk.objectRefTarget(f);   // package-aware (ADR-0042)
                if (target != null) v.put("$ref", refFor.apply(target)); else v.put("type", "object");
            }
            default -> v.put("type", "string");
        }
        Integer max = ModelWalk.maxLength(f);
        if (max != null) v.put("maxLength", max);
        // ModelWalk.isArray, never f.isArray(): that is the own flag and misses inheritance.
        if (!ModelWalk.isArray(f)) return v;
        Map<String, Object> arr = new LinkedHashMap<>();
        arr.put("type", "array");
        arr.put("items", v);
        return arr;
    }

    /** A tiny, dependency-free JSON writer (2-space indent) — swap in Jackson if you have it. */
    public static String json(Object value, String indent) {
        if (value instanceof Map<?, ?> map) {
            if (map.isEmpty()) return "{}";
            String inner = indent + "  ";
            return map.entrySet().stream()
                .map(e -> inner + quote(String.valueOf(e.getKey())) + ": " + json(e.getValue(), inner))
                .collect(Collectors.joining(",\n", "{\n", "\n" + indent + "}"));
        }
        if (value instanceof List<?> list) {
            if (list.isEmpty()) return "[]";
            String inner = indent + "  ";
            return list.stream().map(x -> inner + json(x, inner))
                .collect(Collectors.joining(",\n", "[\n", "\n" + indent + "]"));
        }
        if (value instanceof String s) return quote(s);
        return String.valueOf(value);
    }

    private static String quote(String s) {
        return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n") + "\"";
    }
}
