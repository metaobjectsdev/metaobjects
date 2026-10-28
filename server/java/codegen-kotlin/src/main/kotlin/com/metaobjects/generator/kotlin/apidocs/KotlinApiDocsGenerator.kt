package com.metaobjects.generator.kotlin.apidocs

// Eject note (ADR-0034 Amendment 8): `mvn metaobjects:eject -Dnames=api-docs` copies this file with the
// api reference's IR, builder, renderer and page paths. The siblings below stay in their packages as
// engine, so each is imported by name — a bare same-package reference would not resolve from the copy.
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
 * An ordinary generator: a `<generator>` entry in the list `mvn metaobjects:generate` runs, and
 * nothing writes these pages for a pom that does not list it (ADR-0034 Amendment 9). Its files
 * land under `outputDir` in [ARG_API_SUBDIR]; the project label, the layout and the model
 * back-link base are the other `<args>` below, and where a `@provided` enum is referenced from
 * comes from the same enum args every Kotlin generator takes ([Fr019SharedEnum.ProvidedEnumConfig]).
 * Give it an `outputDir` that holds generated files only: `mvn metaobjects:verify` compares each
 * output directory as one tree, so a hand-written page there reads as stale.
 */
class KotlinApiDocsGenerator : FileEmittingGenerator() {

    override fun generate(loader: MetaDataLoader): List<EmittedFile> {
        val project = getArg(ARG_PROJECT_NAME, "project")
        val subDir = getArg(ARG_API_SUBDIR, DEFAULT_API_SUBDIR)
        val modelBaseUrl = if (hasArg(ARG_MODEL_BASE_URL)) getArg(ARG_MODEL_BASE_URL) else null
        val layout = when (val value = getArg(ARG_LAYOUT, LAYOUT_FLAT)) {
            LAYOUT_FLAT -> DocsPaths.Layout.FLAT
            LAYOUT_PACKAGE -> DocsPaths.Layout.PACKAGE
            // A misspelt layout would otherwise write every page somewhere its links do not point.
            else -> throw GeneratorException(
                "api-docs: <$ARG_LAYOUT> must be $LAYOUT_FLAT or $LAYOUT_PACKAGE (got \"$value\")")
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
            // No model pages are written beside the api pages, so a relative link would be dead:
            // the link is emitted only against a <modelBaseUrl> that hosts them.
            val modelHref = if (modelBaseUrl.isNullOrEmpty()) null
                else DocsPaths.modelCrossHref("$subDir/$pagePath", pagePath, modelBaseUrl)
            add(pagePath, renderer.renderUnitPage(unit, modelHref))
        }
        add("README.md", renderer.renderIndex(model, layout))
        add("AGENT-API.md", renderer.renderAgentApi(model))
        return pages
    }

    companion object {
        /** Arg: the label the agent page carries in its header. Default `project`. */
        const val ARG_PROJECT_NAME: String = "projectName"

        /** Arg: where under `outputDir` the pages land. Default [DEFAULT_API_SUBDIR]. */
        const val ARG_API_SUBDIR: String = "apiSubDir"

        /** Arg: the page layout, `flat` (one file per unit, the default) or `package`. */
        const val ARG_LAYOUT: String = "layout"

        /** Arg: the base URL the pages' links to the model pages are written against; with none set, the pages carry no such link. */
        const val ARG_MODEL_BASE_URL: String = "modelBaseUrl"

        /** The api-surface subdirectory of the cross-port docs contract. */
        const val DEFAULT_API_SUBDIR: String = "api/kotlin"

        private const val LAYOUT_FLAT = "flat"
        private const val LAYOUT_PACKAGE = "package"
    }
}
