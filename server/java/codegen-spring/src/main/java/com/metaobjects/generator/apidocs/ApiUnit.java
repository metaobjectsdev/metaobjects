package com.metaobjects.generator.apidocs;
import java.util.List;
/** One documented unit (an entity or a template) + its symbols + an optional worked example. */
public record ApiUnit(String node, String pkg, String kind /* "entity" | "projection" | "value" | "template" */,
                      List<ApiSymbol> symbols, UnitExample example /* nullable */) {}
