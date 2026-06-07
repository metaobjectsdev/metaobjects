package com.metaobjects.generator.apidocs;
import java.util.List;
/** The full per-project Java SDK api surface IR. */
public record JavaApiModel(String project, List<ApiUnit> units) {}
