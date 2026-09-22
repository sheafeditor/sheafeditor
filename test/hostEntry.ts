/*
 * Entry point for the extension-host checks in textSync.test.mjs. It gathers what
 * those checks drive into one module so they can bundle the real host code against a
 * stand-in for the `vscode` module.
 */

export { activate, MARKDOWN_EXTENSIONS } from '../src/extension';
export { MarkdownEditorProvider, tableOfContentsOn } from '../src/markdownEditorProvider';
export { syncDefaultEditorAssociation, PATTERNS } from '../src/defaultEditor';
