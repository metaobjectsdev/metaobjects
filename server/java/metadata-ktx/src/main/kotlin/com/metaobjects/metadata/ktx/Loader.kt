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

/** Load metadata from a single inline string (defaults to JSON). */
fun loadString(
    name: String,
    content: String,
    format: MetaDataFormat = MetaDataFormat.JSON,
): MetaDataLoader = MetaDataLoader.fromString(name, content, format)
