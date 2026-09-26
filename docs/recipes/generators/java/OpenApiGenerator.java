// EXAMPLE GENERATOR — copy beside JsonSchemaGenerator.java (it reuses that file's field
// mapping) and own it. Not a supported MetaObjects product surface.
//
//   <generator>
//     <classname>com.acme.codegen.OpenApiGenerator</classname>
//     <args>
//       <outputDir>${project.basedir}/src/main/resources/api</outputDir>
//       <title>Shop</title>
//       <apiPrefix>/api</apiPrefix>
//     </args>
//   </generator>
//
// Emits openapi.json (OpenAPI 3.1): every concrete object as a component schema, and the
// cross-port CRUD paths for each object that has a source. Custom <args> reach the
// generator through getArg(name, default).
package com.acme.codegen;

import com.metaobjects.generator.FileEmittingGenerator;
import com.metaobjects.generator.ModelWalk;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.object.MetaObject;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

public class OpenApiGenerator extends FileEmittingGenerator {

    @Override
    protected List<EmittedFile> generate(MetaDataLoader loader) {
        String prefix = getArg("apiPrefix", "");
        Map<String, Object> schemas = new LinkedHashMap<>();
        Map<String, Object> paths = new LinkedHashMap<>();
        for (MetaObject obj : ModelWalk.concreteObjects(loader)) {
            String name = ModelWalk.name(obj);
            schemas.put(name, JsonSchemaGenerator.objectSchema(obj, t -> ref(ModelWalk.name(t))));
            if (!ModelWalk.hasSource(obj)) continue;              // a value object has no routes
            String base = prefix + "/" + ModelWalk.collectionSegment(obj);
            paths.put(base, map(
                "get", op("list" + name, null, "200", "OK", null),
                "post", op("create" + name, row(name), "201", "Created", row(name))));
            Map<String, Object> item = new LinkedHashMap<>();
            item.put("get", op("get" + name, null, "200", "OK", row(name)));
            item.put("patch", op("update" + name, row(name), "200", "OK", row(name)));
            item.put("delete", op("delete" + name, null, "204", "Deleted", null));
            paths.put(base + "/{id}", item);
        }
        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("openapi", "3.1.0");
        doc.put("info", map("title", getArg("title", "API"), "version", "0.0.0"));
        doc.put("paths", paths);
        doc.put("components", map("schemas", schemas));
        return List.of(new EmittedFile("openapi.json", JsonSchemaGenerator.json(doc, "") + "\n"));
    }

    /** An insertion-ordered map. Never Map.of for output: its iteration order changes from
     *  one JVM run to the next, so `mvn metaobjects:verify` would see drift that is not there. */
    private static Map<String, Object> map(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) m.put((String) kv[i], kv[i + 1]);
        return m;
    }

    private static String ref(String name) {
        return "#/components/schemas/" + name;
    }

    private static Map<String, Object> row(String name) {
        return map("content", map("application/json", map("schema", map("$ref", ref(name)))));
    }

    private static Map<String, Object> op(String id, Map<String, Object> body, String status, String desc,
                                          Map<String, Object> response) {
        Map<String, Object> resp = new LinkedHashMap<>();
        resp.put("description", desc);
        if (response != null) resp.putAll(response);
        Map<String, Object> op = new LinkedHashMap<>();
        op.put("operationId", id);
        if (body != null) op.put("requestBody", body);
        op.put("responses", map(status, resp));
        return op;
    }
}
