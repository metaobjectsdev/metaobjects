package com.metaobjects.generator.apidocs;
import java.util.List;
/** One documented symbol of the generated Java SDK surface. NAMES come from the SpringNaming seam
 *  (never invented), so documented == generated. */
public record ApiSymbol(
    String name,
    ApiSymbolKind kind,
    String importFqn,       // fully-qualified type the symbol lives on (e.g. "acme.blog.AuthorDto")
    String signature,       // human-readable Java signature
    List<String> params,    // param descriptions (may be empty)
    String usage,           // one-line "what you use this for"
    String returns,         // description of the symbol's return surface (nullable)
    String throwsNote,      // when/why it throws (nullable)
    UnitExample example,    // nullable
    List<FieldShape> fields // payload/dto field shapes (may be empty)
) {}
