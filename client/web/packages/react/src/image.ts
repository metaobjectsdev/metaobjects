// `@metaobjectsdev/react/image-upload`: the upload-and-crop control, on its own subpath.
//
// `react-easy-crop` is an OPTIONAL peer. A bundler resolves the whole import graph before it
// tree-shakes, and a dynamic import() of a package that is not installed is fatal to webpack,
// Next.js, esbuild and Bun, so nothing reachable from the package root may import it (#287;
// test/browser-bundleable.test.ts holds every optional peer to that). A project with a
// `view.image` field installs react-easy-crop and imports from here; every other project
// installs nothing extra. The adapter contract stays on the root, because it imports nothing
// optional and an app wires it once for the whole tree.
export { ImageUpload, type ImageUploadProps } from "./image-upload.js";
export { cropToBlob } from "./crop-to-blob.js";
