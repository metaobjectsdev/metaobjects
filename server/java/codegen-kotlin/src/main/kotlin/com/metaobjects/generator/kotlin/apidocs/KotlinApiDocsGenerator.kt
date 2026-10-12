package com.metaobjects.generator.kotlin.apidocs

// Eject note (ADR-0034 Amendment 8): `mvn metaobjects:eject -Dnames=api-docs` copies this file with the
// api reference's IR, builder, renderer and page paths. The siblings below stay in their packages as
// engine, so each is imported by name — a bare same-package reference would not resolve from the copy.
import com.metaobjects.generator.DocsGenerator
import com.metaobjects.generator.FileEmittingGenerator
import com.metaobjects.generator.FileEmittingGenerator.EmittedFile
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.kotlin.Fr019SharedEnum
import com.metaobjects.loader.MetaDataLoader

/**
 * `api-docs` — the Kotlin SDK api reference (the `api/kotlin` surface of the cross-port SDK-docs
 * contract): one page per entity, value object, projection, served report and template, an index,
 * and the agent-facing `AGENT-API.md`.
 *
 * Run by `mvn metaobjects:docs`, not by `mvn metaobjects:generate`: it implements [DocsGenerator],
 * which `generate` and `verify` skip. Its files land under `outputDir`, the docs directory, in
 * [DocsGenerator.ARG_API_SUBDIR]. The project label, the layout and the model back-link base come
 * from the [DocsGenerator] args the goal sets, and where a `@provided` enum is referenced from
 * comes from the same enum args every Kotlin generator takes ([Fr019SharedEnum.ProvidedEnumConfig]).
 */
class KotlinApiDocsGenerator : FileEmittingGenerator(), DocsGenerator {

    override fun surface(): String = "kotlin"

    override fun generate(loader: MetaDataLoader): List<EmittedFile> {
        val project = getArg(DocsGenerator.ARG_PROJECT_NAME, "project")
        val subDir = getArg(DocsGenerator.ARG_API_SUBDIR, DEFAULT_API_SUBDIR)
        val modelBaseUrl = if (hasArg(DocsGenerator.ARG_MODEL_BASE_URL)) getArg(DocsGenerator.ARG_MODEL_BASE_URL) else null
        val layout = if (getArg(DocsGenerator.ARG_LAYOUT, "flat").equals("package", ignoreCase = true)) {
            DocsPaths.Layout.PACKAGE
        } else {
            DocsPaths.Layout.FLAT
        }

        val model = KotlinApiModelBuilder(Fr019SharedEnum.ProvidedEnumConfig.fromArgs(args)).build(loader, project)
        val renderer = KotlinApiDocsRenderer()

        val pages = mutableListOf<EmittedFile>()
        val paths = HashSet<String>()
        fun add(pagePath: String, content: String) {
            if (!paths.add(pagePath)) throw GeneratorException("api-docs: duplicate api page output path: $pagePath")
            pages.add(EmittedFile("$subDir/$pagePath", content))
        }
        for (unit in model.units) {
            val pagePath = DocsPaths.docPageOutputPath(layout, unit.pkg, unit.node)
            val modelHref = DocsPaths.modelCrossHref("$subDir/$pagePath", pagePath, modelBaseUrl)
            add(pagePath, renderer.renderUnitPage(unit, modelHref))
        }
        add("README.md", renderer.renderIndex(model, layout))
        add("AGENT-API.md", renderer.renderAgentApi(model))
        return pages
    }

    companion object {
        /** The api-surface subdirectory of the cross-port docs contract. */
        const val DEFAULT_API_SUBDIR: String = "api/kotlin"
    }
}
