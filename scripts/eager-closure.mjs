/*
 * What a browser fetches before the editor runs, read out of an esbuild metafile.
 *
 * **One definition, used by two checks that cannot share a build.** The host suite asserts a band on
 * the closure's raw size and runs before anything is built, so it builds in memory. `check-bundle-size.mjs`
 * reports the gzipped figure per profile and the libraries inside it, and it runs after the build so it
 * can measure the bundle a consumer is actually served. Two sources, necessarily; the walk over them is
 * this file, because a closure defined twice is two answers to one question and the second one drifts
 * without anybody choosing it.
 *
 * **Why a metafile rather than reading the output.** `imports[].kind` is the bundler's own answer to
 * the only question that matters here: a `dynamic-import` costs nothing until something asks for it,
 * and an `import-statement` is paid on open. Nothing in the output text distinguishes them reliably.
 * Reading the files instead has been wrong twice: the entry alone misses the chunks it imports, and a
 * grep for `from"..."` misses a side-effect `import"x"` that costs exactly as much.
 *
 * **And why not a name search.** `media/webview.js` holds the string `mermaid` three times, in a
 * dynamic import and two class names, with none of the 6.5 MB library in it. It holds `katex` three
 * times and all of KaTeX. A name says a library was mentioned.
 */

/**
 * Every output reached from `entry` by a static import, the entry included.
 *
 * `entry` is a key of `metafile.outputs`, which is a path relative to the build's working directory.
 */
export function eagerOutputs(metafile, entry) {
  const outputs = metafile.outputs;
  if (!outputs[entry]) {
    throw new Error(`${entry} is not an output of this build, so the eager closure has no starting point`);
  }
  const eager = new Set([entry]);
  const stack = [entry];
  while (stack.length) {
    for (const im of outputs[stack.pop()]?.imports ?? []) {
      if (im.kind === 'import-statement' && !eager.has(im.path)) {
        eager.add(im.path);
        stack.push(im.path);
      }
    }
  }
  return eager;
}

/**
 * The npm package an input belongs to, or Sheaf's own source.
 *
 * The last `node_modules/` rather than the first, because a dependency of a dependency carries the
 * outer one's path in front of it and the inner name is the one that answers "whose bytes are these".
 */
export function packageOf(path) {
  const at = path.lastIndexOf('node_modules/');
  if (at < 0) return 'sheaf (src/)';
  const parts = path.slice(at + 'node_modules/'.length).split('/');
  return parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

/** Bytes each package contributed to the given outputs, as the bundler counted them. */
export function bytesByPackage(metafile, outputs) {
  const bytes = {};
  for (const file of outputs) {
    for (const [input, info] of Object.entries(metafile.outputs[file].inputs)) {
      const pkg = packageOf(input);
      bytes[pkg] = (bytes[pkg] ?? 0) + info.bytesInOutput;
    }
  }
  return bytes;
}
