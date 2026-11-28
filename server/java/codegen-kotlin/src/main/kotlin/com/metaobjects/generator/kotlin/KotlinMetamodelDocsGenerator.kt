package com.metaobjects.generator.kotlin

import com.metaobjects.docs.metamodel.MetamodelDocsEmitter
import com.metaobjects.generator.FileEmittingGenerator
import com.metaobjects.generator.FileEmittingGenerator.EmittedFile
import com.metaobjects.loader.MetaDataLoader
import java.nio.file.Path

/**
 * `metamodel-docs`: the reference of the built-in metamodel - every type, subtype and attribute the build
 * registers, by provider - as `INDEX.md`, `providers.md` and one `types/<family>.md` per type family, rendered
 * from the shared `templates/metamodel/` Mustache set. The Kotlin sibling of the JVM `MetamodelDocsGenerator`:
 * the pages are language-neutral, so both write identical bytes.
 *
 * It reads no model objects: the vocabulary is the build's own registry. This file decides where the pages
 * go; what there is to emit (the page data) and the templates stay in the package, so a copy
 * (`mvn metaobjects:eject`) can lay the pages out differently, and a project that wants other page text puts a
 * same-path template earlier on the classpath or names a `metamodelTemplateDir`.
 *
 * Args: `outputDir` (required), `subDir` (where under it the pages land, default `metamodel`; empty writes at
 * the root) and `metamodelTemplateDir` (a directory holding `metamodel/<page>.mustache` overrides).
 */
open class KotlinMetamodelDocsGenerator : FileEmittingGenerator() {

    override fun generate(loader: MetaDataLoader): List<EmittedFile> {
        val subDir = getArg(ARG_SUB_DIR, DEFAULT_SUB_DIR)
        val templateDir: Path? = if (hasArg(ARG_TEMPLATE_DIR)) Path.of(getArg(ARG_TEMPLATE_DIR)) else null
        return MetamodelDocsEmitter.emit(subDir, templateDir).map { (path, content) -> EmittedFile(path, content) }
    }

    companion object {
        const val ARG_SUB_DIR = "subDir"
        const val ARG_TEMPLATE_DIR = "metamodelTemplateDir"
        const val DEFAULT_SUB_DIR = "metamodel"
    }
}
