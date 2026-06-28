package com.metaobjects.generator.template;

import com.metaobjects.object.MetaObject;
import com.metaobjects.render.templategen.TemplateWalkResult;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.function.Function;

/**
 * The three built-in walk scopes (SP-1 §3.1): {@code perEntity}, {@code perPackage},
 * {@code perModel}. Each yields the neutral data dict for its unit and names the
 * file via {@link OutputPattern}. Same vocabulary as the TS engine helpers.
 */
public final class ScopeWalk {

    private ScopeWalk() {}

    public static final String PER_ENTITY = "perEntity";
    public static final String PER_PACKAGE = "perPackage";
    public static final String PER_MODEL = "perModel";

    public static Function<List<MetaObject>, List<TemplateWalkResult>> forScope(
            String scope, String outputPattern) {
        return objects -> {
            List<MetaObject> concrete = new ArrayList<>();
            for (MetaObject o : objects) {
                if (TemplateData.isConcrete(o)) concrete.add(o);
            }
            List<TemplateWalkResult> out = new ArrayList<>();
            switch (scope) {
                case PER_ENTITY:
                    for (MetaObject o : concrete) {
                        out.add(new TemplateWalkResult(
                            TemplateData.entity(o),
                            OutputPattern.expand(outputPattern, TemplateData.bareName(o), TemplateData.packageOf(o))));
                    }
                    return out;
                case PER_PACKAGE: {
                    Map<String, List<MetaObject>> byPkg = new TreeMap<>();
                    for (MetaObject o : concrete) {
                        byPkg.computeIfAbsent(TemplateData.packageOf(o), k -> new ArrayList<>()).add(o);
                    }
                    for (Map.Entry<String, List<MetaObject>> e : byPkg.entrySet()) {
                        out.add(new TemplateWalkResult(
                            TemplateData.pkg(e.getKey(), e.getValue()),
                            OutputPattern.expand(outputPattern, null, e.getKey())));
                    }
                    return out;
                }
                case PER_MODEL:
                    out.add(new TemplateWalkResult(
                        TemplateData.model(objects),
                        OutputPattern.expand(outputPattern, null, null)));
                    return out;
                default:
                    throw new IllegalArgumentException(
                        "unknown template scope '" + scope + "' (expected "
                        + PER_ENTITY + " | " + PER_PACKAGE + " | " + PER_MODEL + ")");
            }
        };
    }
}
