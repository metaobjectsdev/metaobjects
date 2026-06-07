package com.metaobjects.generator.apidocs;
/** A documented field: name + Java type + optionality + an optional note (e.g. enum values). */
public record FieldShape(String name, String type, boolean optional, String note) {}
