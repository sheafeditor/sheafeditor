/*
 * What the server suite is run against: the local server and the pieces it is
 * built from.
 *
 * All of it is plain Node, so unlike the webview suites there is no stand-in to
 * build here. The checks start a real server on a real folder in a temporary
 * directory and talk to it over HTTP, because the things worth checking are the
 * ones that only exist once a request is being parsed: which paths are refused,
 * what a header does, and what ends up in the file afterwards.
 */

export { resolveInside, resolveAddress, relativePosix, folderOf, joinRelative } from '../src/server/paths';
export { stripJsonc, readConfig, DEFAULT_CONFIG } from '../src/server/settings';
export { OpenDocument, DocumentStore } from '../src/server/documents';
export { createSheafServer, hostIsLoopback, originIsOurs } from '../src/server/server';
export { escapeHtml, editorPage, indexPage } from '../src/server/page';
export { parseArgs } from '../src/server/main';
