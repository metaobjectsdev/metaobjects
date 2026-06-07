package com.metaobjects.generator.apidocs;
import java.util.List;
/** A worked example: import lines + body statements (kept separate so renderers can dedupe imports). */
public record UnitExample(List<String> imports, List<String> body) {}
