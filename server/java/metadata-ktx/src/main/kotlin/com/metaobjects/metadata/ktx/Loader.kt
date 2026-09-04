package com.metaobjects.metadata.ktx

import com.metaobjects.loader.DirectorySource
import com.metaobjects.loader.LoaderOptions
import com.metaobjects.loader.MetaDataLoader
import com.metaobjects.loader.MetaDataSource.MetaDataFormat
import java.net.URI
import java.nio.file.Path

/**
 * Top-level loader factory shortcuts — match the cross-port convention used by
 * the TS and Python implementations. Each shortcut forwards to the corresponding
 * [MetaDataLoader] static factory.
 */

/** Load metadata from a filesystem directory; pass [DirectorySource.Options] to tune expansion. */
fun loadDirectory(
    name: String,
    directory: Path,
    opts: DirectorySource.Options = DirectorySource.Options(),
): MetaDataLoader = MetaDataLoader.fromDirectory(name, directory, opts)

/** Load metadata from a list of URIs; pass [LoaderOptions] to tune (e.g. `strict=true`). */
fun loadUris(
    name: String,
    uris: List<URI>,
    opts: LoaderOptions? = null,
): MetaDataLoader = MetaDataLoader.fromUris(name, uris, opts)

/** Load metadata from classpath resource paths; pass [LoaderOptions] to tune. */
fun loadResources(
    name: String,
    resources: List<String>,
    opts: LoaderOptions? = null,
): MetaDataLoader = MetaDataLoader.fromResources(name, resources, opts)

/**
 * Load metadata from a single inline string (defaults to JSON); pass [LoaderOptions] to
 * tune (e.g. `strict=true`), matching [loadUris] and [loadResources].
 *
 * The options parameter is the point: without it this was the ONE loader entry that could
 * not opt into strict, so an inline fixture — which is what every codegen test uses — was
 * always loaded lax and an `errors == []` assertion proved only that the document parses,
 * never that it is legal under the sealed registry (ADR-0023).
 */
fun loadString(
    name: String,
    content: String,
    format: MetaDataFormat = MetaDataFormat.JSON,
    opts: LoaderOptions? = null,
): MetaDataLoader = MetaDataLoader.fromString(name, content, format, opts)
