package com.metaobjects.generator.apidocs;
import java.util.List;
/** One documented unit (an entity or a template) + its symbols. */
public record ApiUnit(String node, String pkg, String kind /* "entity" | "template" */, List<ApiSymbol> symbols) {}
