package com.metaobjects.generator.kotlin

import com.metaobjects.config.SharedModel
import com.metaobjects.generator.FileEmittingGenerator
import com.metaobjects.generator.FileEmittingGenerator.EmittedFile
import com.metaobjects.generator.GeneratorException
import com.metaobjects.generator.ProjectVersionAware
import com.metaobjects.loader.MetaDataLoader
import java.nio.file.Path

/**
 * FR-023: publishes a project's shared model - a flattened, canonical-JSON artifact plus the
 * manifest that pins it - for a consumer's `meta deps sync`. The Kotlin sibling of the JVM
 * `SharedModelGenerator`; the artifact is language-neutral JSON, so both write identical bytes.
 *
 * This file decides what belongs to the PUBLISHING PROJECT: which of its source files may
 * contribute (`files`), which nodes are published (`include` / `exclude`) and which version is
 * recorded. Everything a consumer checks is [SharedModel]'s, in the package: what is selected,
 * that the selection is closed, the document's bytes, the hash over them and the manifest's shape
 * and file names. It is a reference helper (ADR-0034 Amendment 3): `mvn metaobjects:eject` copies
 * this one file into your project, and the artifact bytes stay in the package, because a copy that
 * changed them would publish a model a consumer's sync refuses, or accepts and cannot load.
 *
 * Args: `outputDir`, `name` (the dependency key a consumer syncs under; the artifact is
 * `<name>.metaobjects.json`), `include` (comma-separated scope patterns, such as
 * `acme::common::**`), `files` (comma-separated metadata files that may contribute), and
 * optionally `exclude` (applied after `include`) and `version` (default: the project's version).
 */
open class KotlinSharedModelGenerator : FileEmittingGenerator(), ProjectVersionAware {

    private var projectVersion: String? = null

    override fun setProjectVersion(projectVersion: String) {
        this.projectVersion = projectVersion
    }

    override fun generate(loader: MetaDataLoader): List<EmittedFile> {
        val name = required(ARG_NAME, "the dependency key a consumer will sync under")
        val include = list(required(ARG_INCLUDE, "the scope patterns to publish, such as acme::common::**"))
        val exclude = if (hasArg(ARG_EXCLUDE)) list(getArg(ARG_EXCLUDE)) else emptyList()
        val files = list(required(ARG_FILES, "the metadata files that may contribute, comma-separated")).map { Path.of(it) }
        // The providers the project's own load used, so its extra attributes load here too.
        val providers = loader.loaderOptions.providers

        val model = SharedModel.build(SharedModel.Input(name, files, include, exclude, providers))

        // Resolved after the selection has passed every check, so a model that cannot be published
        // says so before a missing version does.
        val version = (if (hasArg(ARG_VERSION) && !getArg(ARG_VERSION).isBlank()) getArg(ARG_VERSION).trim() else projectVersion)
        if (version.isNullOrBlank()) {
            throw GeneratorException(
                "shared-model \"$name\": no version available - set <args><$ARG_VERSION>...</$ARG_VERSION></args>, " +
                    "or run through the Maven plugin, which supplies \${project.version}.",
            )
        }

        val out = SharedModel.render(model, version)
        return listOf(EmittedFile(out.artifactPath(), out.artifact()), EmittedFile(out.manifestPath(), out.manifest()))
    }

    private fun required(arg: String, what: String): String {
        val value = getArg(arg)
        if (value.isNullOrBlank()) {
            throw GeneratorException("shared-model: set '$arg' with <args><$arg>...</$arg></args> ($what)")
        }
        return value.trim()
    }

    private fun list(commaSeparated: String): List<String> =
        commaSeparated.split(",").map { it.trim() }.filter { it.isNotEmpty() }

    companion object {
        const val ARG_NAME = "name"
        const val ARG_INCLUDE = "include"
        const val ARG_EXCLUDE = "exclude"
        const val ARG_FILES = "files"
        const val ARG_VERSION = "version"
    }
}
