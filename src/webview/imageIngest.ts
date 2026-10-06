/*
 * Getting an image into the document: a drop, a paste, the file picker, and the host round trip
 * that saves the bytes.
 *
 * Split out of `images.ts`, which was one module for three jobs. The other two are `imageMarkup.ts`,
 * which parses and writes the markup, and the drawing half that stays in `images.ts` with the widget,
 * the resize handles and the captions.
 *
 * **Ingestion is not drawing, and that distinction is why this file exists.** The seam was first
 * described as parse-versus-draw, which would have left `toolbar.ts` where it was: its only use of
 * the old module is `pickImage`, and a picker needs none of the widget machinery. With this split
 * `toolbar.ts`, `linkTarget.ts`, `tables.ts` and `main.ts` all stop reaching the drawing half, and
 * `livePreview.ts` is the only module that still does.
 *
 * The direction is a chain and not a cycle: drawing reaches in here for `saveImageFile`, which the
 * Replace action on a widget needs, and this file reaches `imageMarkup.ts` for the rule about
 * writing a destination. Nothing here reaches back into the drawing half.
 */

import type { FromWebview } from '../protocol';
import { EditorView } from '@codemirror/view';
import { installLinkPaste } from './linkPaste';
import { mdDestination } from './imageMarkup';

// ---- Drag / drop / paste ingestion ----------------------------------------

type VsPost = (message: FromWebview) => void;

let seq = 0;
const pending = new Map<string, { resolve: (path: string) => void; reject: (err: Error) => void }>();
/** Set once at init so widget actions (e.g. Replace) can reach the host. */
let ingestPost: VsPost | null = null;

/** Ask the host to persist an image; resolves with the workspace-relative path. */
function requestSaveImage(post: VsPost, name: string, data: string): Promise<string> {
  const id = `img-${++seq}`;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    post({ type: 'saveImage', id, name, data });
  });
}

/**
 * Encode a file and hand it to the host; resolves with the workspace-relative path.
 *
 * Exported for the drawing half's Replace action, which is the one thing a widget does that needs
 * the host rather than the document. It is the only edge from `images.ts` into this file.
 */
export async function saveImageFile(file: File | Blob): Promise<string> {
  if (!ingestPost) throw new Error('image ingestion not ready');
  const anyFile = file as File;
  const stamp = String(Date.now()).slice(-6);
  const name = anyFile.name || `pasted-image-${stamp}${extFor(file, '')}`;
  const data = await fileToBase64(file);
  return requestSaveImage(ingestPost, name, data);
}

/** Host reply router — called from main.ts's message handler. */
export function handleImageSaved(id: string, path?: string, error?: string): void {
  const p = pending.get(id);
  if (!p) return;
  pending.delete(id);
  if (error || !path) p.reject(new Error(error ?? 'save failed'));
  else p.resolve(path);
}

async function fileToBase64(file: File | Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/** The part of a thrown error worth reading. */
function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function baseName(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').trim();
}

function extFor(file: File | Blob, fallbackName: string): string {
  const fromName = /\.[a-z0-9]+$/i.exec(fallbackName)?.[0];
  if (fromName) return fromName;
  const mime = file.type.split('/')[1];
  return mime ? `.${mime.replace('+xml', '')}` : '.png';
}

/** Save dropped/pasted image files and insert Markdown at `at`. */
async function ingest(view: EditorView, files: File[], at: number): Promise<void> {
  let cursor = at;
  for (const file of files) {
    let relPath: string;
    try {
      relPath = await saveImageFile(file);
    } catch (err) {
      // The host says why it could not save, in a notification naming the
      // reason, so nothing is inserted and nothing more is said here. Every
      // reason a save fails is about the document rather than this one file, so
      // the files behind it would fail the same way and stack up the same
      // notification; the run stops instead.
      console.warn(`Sheaf could not save a pasted image: ${reasonOf(err)}`);
      break;
    }
    const line = view.state.doc.lineAt(Math.min(cursor, view.state.doc.length));
    const prefix = cursor === line.from ? '' : '\n';
    // The image needs a line of its own, and the break that starts one can
    // double as the break that ends it: when the caret is at the end of a line
    // the document already continues on the next, so adding a second break
    // would open a blank line the person never typed.
    const suffix = prefix && view.state.doc.sliceString(cursor, cursor + 1) === '\n' ? '' : '\n';
    const alt = baseName(relPath.split('/').pop() ?? relPath);
    /*
     * Through `mdDestination`, which is the rule for writing an address, rather than inserting the
     * path raw.
     *
     * A space ends a destination in CommonMark, so a pasted file called `Screen Shot 2026-09-30 at
     * 7.59.12 PM.png` wrote `![...](assets/Screen Shot ... .png)`, which is a broken link in the
     * file: no picture drawn here, and wrong on GitHub and under pandoc too. Renaming the image
     * afterwards does not repair the document.
     *
     * **It needed both halves to go wrong, which is why it survived.** Two hosts save a pasted image
     * and they sanitise the filename differently: one replaces every character outside
     * `[a-zA-Z0-9._-]` with a dash, so a space can never reach here, and the other only replaces
     * path separators and leading dots, so it can. A raw insertion is harmless behind the strict
     * sanitiser and a loose sanitiser is harmless behind a correct insertion.
     *
     * So the fix is here rather than in either sanitiser. There were two writers of an image
     * destination, `serializeImage` applying the rule and this one not, and a sanitiser is a filter
     * while the serializer is the rule: filters get loosened, and when this one was, nothing between
     * it and the file knew how to quote a space.
     */
    const md = `${prefix}![${alt}](${mdDestination(relPath)})${suffix}`;
    view.dispatch({
      changes: { from: cursor, to: cursor, insert: md },
      selection: { anchor: cursor + md.length },
    });
    cursor += md.length;
  }
  view.focus();
}

/**
 * Save image files through the host and link them at the caret, the way a pasted
 * image is. Resolves once every file has been saved and inserted (or skipped).
 */
export function insertImageFiles(view: EditorView, files: File[]): Promise<void> {
  return ingest(view, files, view.state.selection.main.head);
}

/** Open the platform file picker for images and insert what the person chooses. */
export function pickImage(view: EditorView): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.multiple = true;
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', () => {
    const files = Array.from(input.files ?? []).filter((f) => f.type.startsWith('image/'));
    input.remove();
    if (files.length) void insertImageFiles(view, files);
  });
  // Dismissing the picker fires `cancel` instead of `change`.
  input.addEventListener('cancel', () => input.remove());
  input.click();
}

function imageFilesFrom(dt: DataTransfer | null): File[] {
  if (!dt) return [];
  const out: File[] = [];
  if (dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) if (f.type.startsWith('image/')) out.push(f);
  }
  if (!out.length && dt.items) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) out.push(f);
      }
    }
  }
  return out;
}

/** Attach drop/paste handlers so images become saved files + Markdown. */
export function setupImageIngestion(view: EditorView, post: VsPost): void {
  ingestPost = post;
  const dom = view.dom;

  // A web address pasted over chosen words links them rather than replacing them.
  // It has to be decided further up than the handlers below: CodeMirror answers a
  // paste on the content itself, so by the time one has reached this element the
  // words are already gone.
  installLinkPaste(view);

  dom.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.items ?? []).some((i) => i.kind === 'file')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  dom.addEventListener('drop', (e) => {
    const files = imageFilesFrom(e.dataTransfer);
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const pos = view.posAtCoords({ x: e.clientX, y: e.clientY }) ?? view.state.selection.main.head;
    void ingest(view, files, pos);
  });

  dom.addEventListener('paste', (e) => {
    // Only hijack when there's an image and no competing plain text (so pasting
    // Markdown / prose still goes through CodeMirror normally).
    const text = e.clipboardData?.getData('text/plain') ?? '';
    if (text.trim()) return;
    const files = imageFilesFrom(e.clipboardData);
    if (!files.length) return;
    e.preventDefault();
    void ingest(view, files, view.state.selection.main.head);
  });
}
