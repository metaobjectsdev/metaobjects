package com.metaobjects.generator.apidocs;

import com.metaobjects.generator.spring.LlmTraceHelperGenerator;
import com.metaobjects.generator.spring.SpringControllerGenerator;
import com.metaobjects.generator.spring.SpringDtoGenerator;
import com.metaobjects.generator.spring.SpringFilterAllowlistGenerator;
import com.metaobjects.generator.spring.SpringOutputParserGenerator;
import com.metaobjects.generator.spring.SpringOutputPromptGenerator;
import com.metaobjects.generator.spring.SpringRenderHelperGenerator;
import com.metaobjects.loader.MetaDataLoader;
import com.metaobjects.MetaData;
import com.metaobjects.object.MetaObject;

import java.util.function.BiPredicate;
import java.util.function.Predicate;

/**
 * What the api reference asks of the generators it documents: would you emit for this?
 *
 * <p>The reference documents the code the OTHER generators emit, and it decides what to document
 * by asking each of them the static {@code appliesTo} every one of those generators exposes. The
 * docs generator does not name those generators. It reads the answers from here, so the docs
 * generator, packaged or ejected, depends on nothing but this engine surface, and the reference
 * describes what the packaged generators emit for, including in a project that owns a copy of one
 * of them. {@link #packaged()} carries the packaged generators' own predicates.</p>
 *
 * @param dto             {@code dto}: the object's DTO record
 * @param routes          {@code routes}: the object's controller
 * @param filterAllowlist {@code filter-allowlist}: the object's filter allowlist
 * @param traceHelper     {@code trace-helper}: the object's LLM-trace helper
 * @param renderHelper    {@code render-helper}: the template's render helper
 * @param outputPrompt    {@code output-prompt}: the template's response-format fragment
 * @param outputParser    {@code output-parser}: the template's reply parser
 */
public record GeneratorApplicability(
        Predicate<MetaObject> dto,
        Predicate<MetaObject> routes,
        Predicate<MetaObject> filterAllowlist,
        Predicate<MetaObject> traceHelper,
        BiPredicate<MetaData, MetaDataLoader> renderHelper,
        BiPredicate<MetaData, MetaDataLoader> outputPrompt,
        BiPredicate<MetaData, MetaDataLoader> outputParser) {

    /** The packaged generators' own predicates. */
    public static GeneratorApplicability packaged() {
        return new GeneratorApplicability(
                SpringDtoGenerator::appliesTo,
                SpringControllerGenerator::appliesTo,
                SpringFilterAllowlistGenerator::appliesTo,
                LlmTraceHelperGenerator::appliesTo,
                SpringRenderHelperGenerator::appliesTo,
                SpringOutputPromptGenerator::appliesTo,
                SpringOutputParserGenerator::appliesTo);
    }
}
