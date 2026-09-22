/*
 * Images: what the reader sees for each way an image can be written, and what a
 * toolbar action writes back to the file. Relative paths are resolved against a
 * test base so every widget has a URL it can build, and each check moves the
 * caret off the image's own lines unless the raw markup is what is under test.
 */

import { Scenario, mountProse } from '../harness';
import {
  handleImageSaved,
  insertImageFiles,
  parseMarkdownImage,
  setResourceBaseUri,
  setupImageIngestion,
} from '../../src/webview/images';
import { setLivePreviewConfig } from '../../src/webview/livePreview';

type P = ReturnType<typeof mountProse>;

/** Mount with image resolution pointed at a base the widget can resolve against. */
const mount = (doc: string): P => {
  setResourceBaseUri('https://res.test/');
  return mountProse(doc);
};

/**
 * Mount with the setting Sheaf ships, where a selection shows no syntax. The
 * suite otherwise runs with the opt-in that reveals a selected line's source,
 * which would turn a selected image back into its Markdown.
 */
const mountShipped = (doc: string): P => {
  setLivePreviewConfig({ revealSyntaxOnLine: false });
  const p = mount(doc);
  return {
    ...p,
    destroy: () => {
      p.destroy();
      setLivePreviewConfig({ revealSyntaxOnLine: true });
    },
  };
};

/** Mount against `base`, restoring the suite's own base once `fn` has run. */
const withBase = (base: string, doc: string, fn: (p: P) => boolean): boolean => {
  setResourceBaseUri(base);
  const p = mountProse(doc);
  try {
    return fn(p);
  } finally {
    p.destroy();
    setResourceBaseUri('https://res.test/');
  }
};

/** Collect what the code writes to the console while `fn` runs. */
const warnings = (fn: () => boolean): { ok: boolean; said: string[] } => {
  const said: string[] = [];
  const previous = console.warn;
  console.warn = (...args: unknown[]): void => void said.push(args.map(String).join(' '));
  try {
    return { ok: fn(), said };
  } finally {
    console.warn = previous;
  }
};

const images = (p: P): HTMLImageElement[] =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLImageElement>('img.md-img'));

const wraps = (p: P): HTMLElement[] =>
  Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.md-img-wrap'));

/** Everything the editor shows, widget content included. */
const screen = (p: P): string => p.view.contentDOM.textContent ?? '';

/** Click a button in a rendered image's toolbar by its label, as a person would. */
const clickToolbar = (p: P, label: string): boolean => {
  const button = Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.md-img-btn')).find(
    (el) => el.textContent === label
  );
  if (!button) return false;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
};

const G = globalThis as unknown as { File?: typeof File };

/** A small PNG file to hand the ingestion path. */
const pngFile = (name: string): File => {
  const bytes = new Uint8Array([137, 80, 78, 71]);
  if (typeof G.File === 'function') return new G.File([bytes], name, { type: 'image/png' });
  // Older runtimes have Blob but no File; ingestion reads only name and type.
  const blob = new Blob([bytes], { type: 'image/png' }) as Blob & { name?: string };
  blob.name = name;
  return blob as File;
};

/** Insert `name` at the caret, with the host answering the save at once. */
const insertImage = (p: P, name: string, savedAs: string): Promise<void> => {
  setupImageIngestion(p.view, (message) => {
    handleImageSaved((message as { id: string }).id, savedAs);
  });
  return insertImageFiles(p.view, [pngFile(name)]);
};

/** Insert `name` at the caret, with the host refusing the save for `reason`. */
const insertRefusedImage = (p: P, name: string, reason: string): Promise<void> => {
  setupImageIngestion(p.view, (message) => {
    handleImageSaved((message as { id: string }).id, undefined, reason);
  });
  return insertImageFiles(p.view, [pngFile(name)]);
};

/** Click a toolbar button by its tooltip, for the ones drawn as an icon. */
const clickTitled = (p: P, title: string): boolean => {
  const button = Array.from(p.view.contentDOM.querySelectorAll<HTMLElement>('.md-img-btn')).find(
    (el) => el.title === title
  );
  if (!button) return false;
  button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  return true;
};

/** Type `value` into the inline editor the named toolbar button opens, then press Enter. */
const setText = (p: P, button: string, value: string): boolean => {
  if (!clickToolbar(p, button)) return false;
  const input = p.view.contentDOM.querySelector<HTMLInputElement>('.md-img-input');
  if (!input) return false;
  input.value = value;
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  return true;
};

/** Open the Alt editor on a rendered image, type `value` and press Enter. */
const setAlt = (p: P, value: string): boolean => setText(p, 'Alt', value);

export const scenarios: Scenario[] = [
  {
    name: 'a centred image written over several lines of HTML shows as the picture, not as source',
    run: () => {
      const doc =
        'Intro.\n\n<p align="center">\n  <img src="assets/loaf.png" alt="Centred" width="400">\n</p>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const img = images(p);
      const ok =
        img.length === 1 &&
        img[0].getAttribute('alt') === 'Centred' &&
        img[0].src === 'https://res.test/assets/loaf.png' &&
        wraps(p)[0].classList.contains('md-img-align-center') &&
        !screen(p).includes('<p align') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a figure written over several lines of HTML shows the picture with its caption',
    run: () => {
      const doc =
        'Intro.\n\n<figure>\n  <img src="assets/warning.png" alt="An inline warning" width="560">\n  <figcaption>A caption, which Markdown has no way to express.</figcaption>\n</figure>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const img = images(p);
      const caption = p.view.contentDOM.querySelector('.md-figcaption');
      const ok =
        img.length === 1 &&
        img[0].getAttribute('alt') === 'An inline warning' &&
        caption?.textContent === 'A caption, which Markdown has no way to express.' &&
        !screen(p).includes('<figure>') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the raw HTML of a multi-line figure comes back when the caret is inside it',
    run: () => {
      const doc =
        'Intro.\n\n<p align="center">\n  <img src="assets/loaf.png" alt="Centred" width="400">\n</p>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('<img') + 2);
      const ok = images(p).length === 0 && screen(p).includes('<p align="center">') && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an image whose file name has parentheses asks for the whole name, not a truncated one',
    run: () => {
      const doc = 'Intro.\n\n![Paren](assets/chart(1).png)\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const img = images(p);
      const ok =
        parseMarkdownImage('![Paren](assets/chart(1).png)')?.src === 'assets/chart(1).png' &&
        img.length === 1 &&
        decodeURIComponent(img[0].src).endsWith('/assets/chart(1).png') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an image under a list item shows as the picture, with its controls',
    run: () => {
      const doc = '- Item:\n\n  ![T](t.png)\n\n- Last\n';
      const p = mount(doc);
      p.select(doc.indexOf('Last') + 2);
      const n = images(p).length;
      const buttons = p.view.contentDOM.querySelectorAll('.md-img-btn').length;
      p.destroy();
      return n === 1 && buttons > 0;
    },
  },
  {
    name: 'a reference-style image shows the picture its definition names, in its full and collapsed forms',
    run: () => {
      const doc =
        'Intro.\n\n![Terminal at dawn][dawn]\n\n![dusk][]\n\n[dawn]: assets/terminal-dawn.png "At dawn"\n[dusk]: assets/terminal-dusk.png\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const img = images(p);
      const ok =
        img.length === 2 &&
        img[0].src === 'https://res.test/assets/terminal-dawn.png' &&
        img[0].getAttribute('alt') === 'Terminal at dawn' &&
        img[1].src === 'https://res.test/assets/terminal-dusk.png' &&
        !screen(p).includes('Terminal at dawn[dawn]') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a reference-style image with no matching definition stays as the text it is',
    run: () => {
      const doc = 'Intro.\n\n![Terminal at dawn][missing]\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const ok = images(p).length === 0 && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    // jsdom applies no stylesheet and has no layout, so what is checked here is
    // the class the layout follows from: the wrapper is a block without it,
    // which is what broke the sentence onto three lines.
    name: 'an image written inside a sentence is drawn in the line, not as its own block',
    run: () => {
      const doc =
        'Intro.\n\nHere is a dot ![dot](assets/dot.png) mid-paragraph.\n\n![Alone](assets/dot.png)\n\n- In a list: ![dot](assets/dot.png)\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const [midSentence, alone, inList] = wraps(p);
      const ok =
        wraps(p).length === 3 &&
        midSentence.classList.contains('md-img-inline') &&
        // An image standing alone keeps the block layout the stylesheet gives it.
        !alone.classList.contains('md-img-inline') &&
        inList.classList.contains('md-img-inline') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an HTML image sized inline next to text is drawn in the line',
    run: () => {
      const doc =
        'Intro.\n\n<img src="assets/dot.png" alt="Tiny" width="16" height="16"> sized inline, next to text.\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const ok = wraps(p)[0]?.classList.contains('md-img-inline') === true && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'resizing an image written with a title keeps the title in the file',
    run: () => {
      const doc = 'Before.\n\n![A loaf](assets/rye-loaf.png "Seeded rye")\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const clicked = clickToolbar(p, 'S');
      const ok =
        clicked &&
        p.doc() ===
          'Before.\n\n<img src="assets/rye-loaf.png" alt="A loaf" title="Seeded rye" width="240">\n\nAfter.\n';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'clearing the width of a titled image gives back Markdown with its title',
    run: () => {
      const doc =
        'Before.\n\n<img src="assets/rye-loaf.png" alt="A loaf" title="Seeded rye" width="240">\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const clicked = clickToolbar(p, 'Full');
      const ok = clicked && p.doc() === 'Before.\n\n![A loaf](assets/rye-loaf.png "Seeded rye")\n\nAfter.\n';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'alt text holding brackets is written so the line is still an image',
    run: () => {
      const doc = 'Before.\n\n![Loaf](assets/rye-loaf.png)\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const typed = setAlt(p, 'see [1]');
      const img = images(p);
      const ok =
        typed &&
        p.doc() === 'Before.\n\n![see \\[1\\]](assets/rye-loaf.png)\n\nAfter.\n' &&
        img.length === 1 &&
        img[0].getAttribute('alt') === 'see [1]';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a path with a space keeps its angle brackets through a resize and back',
    run: () => {
      const doc = 'Before.\n\n![Loaf](<assets/rye loaf.png>)\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const small = clickToolbar(p, 'S');
      const sized =
        p.doc() === 'Before.\n\n<img src="assets/rye loaf.png" alt="Loaf" width="240">\n\nAfter.\n';
      const full = clickToolbar(p, 'Full');
      const ok = small && sized && full && p.doc() === doc && images(p).length === 1;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a reference-style image offers no controls, since its form cannot be rewritten',
    run: () => {
      const doc =
        'Intro.\n\n![Terminal at dawn][dawn]\n\n![A loaf](assets/rye-loaf.png)\n\n[dawn]: assets/terminal-dawn.png\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const [reference, written] = wraps(p);
      const ok =
        wraps(p).length === 2 &&
        // Nothing on the reference image promises an action it cannot perform:
        // no width presets, no alignment buttons, no drag handle.
        reference.querySelector('.md-img-toolbar') === null &&
        reference.querySelectorAll('.md-img-btn').length === 0 &&
        reference.querySelector('.md-img-handle') === null &&
        // The image written inline keeps every one of them.
        written.querySelector('.md-img-toolbar') !== null &&
        written.querySelectorAll('.md-img-btn').length > 0 &&
        written.querySelector('.md-img-handle') !== null &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a figure written over several lines of HTML keeps its controls',
    run: () => {
      const doc =
        'Intro.\n\n<figure>\n  <img src="assets/warning.png" alt="A warning" width="560">\n  <figcaption>A caption.</figcaption>\n</figure>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const wrap = wraps(p)[0];
      const ok =
        wrap.querySelector('.md-img-toolbar') !== null &&
        wrap.querySelector('.md-img-handle') !== null &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'resizing an image written with a width and a height keeps the two in proportion',
    run: () => {
      const doc =
        'Before.\n\n<img src="assets/rye-loaf.png" alt="Loaf" width="280" height="160">\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const clicked = clickToolbar(p, 'S');
      // The image is written 280 by 160, which is 7:4, so 240 wide is 137 high.
      const ok =
        clicked &&
        p.doc() ===
          'Before.\n\n<img src="assets/rye-loaf.png" alt="Loaf" width="240" height="137">\n\nAfter.\n';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'clearing the width of an image written with a height drops the height with it',
    run: () => {
      const doc =
        'Before.\n\n<img src="assets/rye-loaf.png" alt="Loaf" width="280" height="160">\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const clicked = clickToolbar(p, 'Full');
      const ok = clicked && p.doc() === 'Before.\n\n![Loaf](assets/rye-loaf.png)\n\nAfter.\n';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'inserting an image at the end of a paragraph leaves the blank line below it alone',
    run: async () => {
      const doc = 'Paste here\n\nAfter the image.\n';
      const p = mount(doc);
      p.select(doc.indexOf('\n'));
      await insertImage(p, 'image.png', 'assets/image.png');
      const ok = p.doc() === 'Paste here\n![image](assets/image.png)\n\nAfter the image.\n';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'captioning a centred image leaves it centred',
    run: () => {
      const doc =
        'Before.\n\n<p align="center"><img src="assets/rye-loaf.png" alt="Loaf" width="300"></p>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const typed = setText(p, 'Caption', 'Cap');
      const ok =
        typed &&
        p.doc() ===
          'Before.\n\n<div align="center"><figure><img src="assets/rye-loaf.png" alt="Loaf" width="300"><figcaption>Cap</figcaption></figure></div>\n\nAfter.\n' &&
        wraps(p)[0].classList.contains('md-img-align-center') &&
        p.view.contentDOM.querySelector('.md-figcaption')?.textContent === 'Cap';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'aligning a captioned image writes the alignment, rather than leaving the file as it was',
    run: () => {
      const doc =
        'Before.\n\n<figure><img src="assets/rye-loaf.png" alt="Loaf" width="300"><figcaption>Cap</figcaption></figure>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const clicked = clickTitled(p, 'Align center');
      const ok =
        clicked &&
        p.doc() ===
          'Before.\n\n<div align="center"><figure><img src="assets/rye-loaf.png" alt="Loaf" width="300"><figcaption>Cap</figcaption></figure></div>\n\nAfter.\n';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a captioned image shows the alignment its wrapper carries, and gives the wrapper back untouched',
    run: () => {
      const doc =
        'Before.\n\n<div align="center"><figure><img src="assets/rye-loaf.png" alt="Loaf" width="300"><figcaption>Cap</figcaption></figure></div>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const ok =
        images(p).length === 1 &&
        wraps(p)[0].classList.contains('md-img-align-center') &&
        p.view.contentDOM.querySelector('.md-figcaption')?.textContent === 'Cap' &&
        !screen(p).includes('<div align') &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a captioned image written over several lines inside an aligned wrapper shows as the picture',
    run: () => {
      const doc =
        'Before.\n\n<div align="center">\n  <figure>\n    <img src="assets/rye-loaf.png" alt="Loaf" width="300">\n    <figcaption>Cap</figcaption>\n  </figure>\n</div>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const ok =
        images(p).length === 1 &&
        wraps(p)[0].classList.contains('md-img-align-center') &&
        p.view.contentDOM.querySelector('.md-figcaption')?.textContent === 'Cap' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'turning the alignment off a captioned image takes the wrapper away with it',
    run: () => {
      const doc =
        'Before.\n\n<div align="center"><figure><img src="assets/rye-loaf.png" alt="Loaf" width="300"><figcaption>Cap</figcaption></figure></div>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const clicked = clickTitled(p, 'Align center');
      const ok =
        clicked &&
        p.doc() ===
          'Before.\n\n<figure><img src="assets/rye-loaf.png" alt="Loaf" width="300"><figcaption>Cap</figcaption></figure>\n\nAfter.\n';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'taking the caption off a centred figure leaves the paragraph form that centres a lone image',
    run: () => {
      const doc =
        'Before.\n\n<div align="center"><figure><img src="assets/rye-loaf.png" alt="Loaf" width="300"><figcaption>Cap</figcaption></figure></div>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const typed = setText(p, 'Caption ✓', '');
      const ok =
        typed &&
        p.doc() ===
          'Before.\n\n<p align="center"><img src="assets/rye-loaf.png" alt="Loaf" width="300"></p>\n\nAfter.\n';
      p.destroy();
      return ok;
    },
  },
  {
    name: 'an image the host cannot save links nothing and says why, rather than doing nothing',
    run: async () => {
      const doc = 'Paste here\n\nAfter the image.\n';
      const p = mount(doc);
      p.select(doc.indexOf('\n'));
      const reason = 'Sheaf: save the document before pasting images.';
      const { ok, said } = await (async () => {
        const collected: string[] = [];
        const previous = console.warn;
        console.warn = (...args: unknown[]): void => void collected.push(args.map(String).join(' '));
        try {
          await insertRefusedImage(p, 'image.png', reason);
          return { ok: p.doc() === doc, said: collected };
        } finally {
          console.warn = previous;
        }
      })();
      p.destroy();
      return ok && said.length === 1 && said[0].includes(reason);
    },
  },
  {
    name: 'an image resolves against a base written as a plain path',
    run: () => {
      const doc = 'Intro.\n\n![Loaf](assets/rye-loaf.png)\n\n![Rooted](/shared/dot.png)\n\nAfter.\n';
      return withBase('/demo/', doc, (p) => {
        p.select(doc.indexOf('After.') + 2);
        const img = images(p);
        return (
          img.length === 2 &&
          img[0].getAttribute('src') === '/demo/assets/rye-loaf.png' &&
          img[1].getAttribute('src') === '/shared/dot.png' &&
          p.doc() === doc
        );
      });
    },
  },
  {
    name: 'an address that names a host without a scheme keeps that host under a path base',
    run: () => {
      const doc = 'Intro.\n\n![CDN](//cdn.example.com/logo.png)\n\nAfter.\n';
      return withBase('/demo/', doc, (p) => {
        p.select(doc.indexOf('After.') + 2);
        const img = images(p);
        return img.length === 1 && img[0].getAttribute('src') === 'https://cdn.example.com/logo.png' && p.doc() === doc;
      });
    },
  },
  {
    name: 'an address that names a host without a scheme resolves the same way under a URL base',
    run: () => {
      const doc = 'Intro.\n\n![CDN](//cdn.example.com/logo.png)\n\nAfter.\n';
      return withBase('https://res.test/', doc, (p) => {
        p.select(doc.indexOf('After.') + 2);
        const img = images(p);
        return img.length === 1 && img[0].getAttribute('src') === 'https://cdn.example.com/logo.png' && p.doc() === doc;
      });
    },
  },
  {
    name: 'a base Sheaf cannot resolve is reported once, naming the base',
    run: () => {
      const doc = 'Intro.\n\n![Loaf](assets/rye-loaf.png)\n\nAfter.\n';
      const { ok, said } = warnings(() =>
        withBase('assets', doc, (p) => {
          p.select(doc.indexOf('After.') + 2);
          // Move the caret again so the decorations are rebuilt: a base that
          // cannot be resolved is reported once, not once per redraw.
          p.select(0);
          p.select(doc.indexOf('After.') + 2);
          return images(p).length === 0 && p.doc() === doc;
        })
      );
      return ok && said.length === 1 && said[0].includes('assets/');
    },
  },
  {
    name: 'inserting an image on a blank line keeps the blank line that follows it',
    run: async () => {
      const doc = 'Paste here\n\nAfter the image.\n';
      const p = mount(doc);
      p.select(doc.indexOf('\n') + 1);
      await insertImage(p, 'image.png', 'assets/image.png');
      const ok = p.doc() === 'Paste here\n![image](assets/image.png)\n\nAfter the image.\n';
      p.destroy();
      return ok;
    },
  },
  {
    // jsdom has no layout, so the look of the grip and its hit area are a real
    // window's to judge. What is checked is what assistive technology reads and
    // what the grip is drawn from: a corner bracket over a halo.
    name: 'the resize handle is a named corner grip, drawn as a bracket over a halo',
    run: () => {
      const doc = 'Before.\n\n![A loaf](assets/rye-loaf.png)\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const handle = p.view.contentDOM.querySelector<HTMLElement>('.md-img-handle');
      const grip = handle?.querySelector('svg.md-img-grip');
      const ok =
        !!handle &&
        handle.getAttribute('aria-label') === 'Resize image' &&
        handle.getAttribute('role') === 'button' &&
        !!grip &&
        grip.getAttribute('aria-hidden') === 'true' &&
        grip.querySelector('.md-img-grip-halo') !== null &&
        grip.querySelector('.md-img-grip-line') !== null &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'the resize grip of a captioned image sits on the picture, not beside the caption',
    run: () => {
      const doc =
        'Before.\n\n<figure><img src="assets/rye-loaf.png" alt="A loaf" width="400"><figcaption>Seeded rye</figcaption></figure>\n\nAfter.\n';
      const p = mount(doc);
      p.select(doc.indexOf('After.') + 2);
      const handle = p.view.contentDOM.querySelector<HTMLElement>('.md-img-handle');
      const frame = handle?.parentElement;
      const ok =
        !!frame &&
        frame.classList.contains('md-img-frame') &&
        frame.querySelector('img.md-img') !== null &&
        frame.querySelector('.md-figcaption') === null &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    // The editor paints a selection behind the content, where an opaque
    // picture covers it, so a selected image is marked for a ring drawn on top.
    // jsdom checks the mark; how the ring looks over a picture is a real window's.
    name: 'selecting an image marks it as selected, and moving the selection off clears the mark',
    run: () => {
      const image = '![A loaf](assets/rye-loaf.png)';
      const doc = `Before.\n\n${image}\n\nAfter.\n`;
      const p = mountShipped(doc);
      const from = doc.indexOf(image);
      p.select(doc.indexOf('After.') + 2);
      const before = wraps(p)[0]?.classList.contains('is-selected');
      p.select(from, from + image.length);
      const selected = wraps(p)[0]?.classList.contains('is-selected');
      p.select(doc.indexOf('After.') + 2);
      const cleared = wraps(p)[0]?.classList.contains('is-selected');
      const ok = before === false && selected === true && cleared === false && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a selection across words and an image in a sentence marks the image, and only the image',
    run: () => {
      const image = '![dot](assets/dot.png)';
      const doc = `Intro.\n\nHere is a dot ${image} mid-paragraph ${image} again.\n\nAfter.\n`;
      const p = mountShipped(doc);
      const first = doc.indexOf(image);
      // From inside "dot" to inside "mid": the first image whole, the second not at all.
      p.select(first - 2, first + image.length + 4);
      const [inside, outside] = wraps(p);
      const across =
        wraps(p).length === 2 &&
        inside.classList.contains('is-selected') &&
        !outside.classList.contains('is-selected') &&
        p.view.contentDOM.querySelectorAll('.is-selected').length === 1;
      // A selection that covers only part of the image's source does not select it.
      p.select(first + 3, first + image.length + 4);
      const partial = !wraps(p).some((w) => w.classList.contains('is-selected'));
      const ok = across && partial && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a selected captioned image is marked around the picture and its caption',
    run: () => {
      const figure =
        '<figure><img src="assets/rye-loaf.png" alt="A loaf" width="400"><figcaption>Seeded rye</figcaption></figure>';
      const doc = `Before.\n\n${figure}\n\nAfter.\n`;
      const p = mountShipped(doc);
      const from = doc.indexOf(figure);
      p.select(from, from + figure.length);
      const wrap = wraps(p)[0];
      const ok =
        !!wrap &&
        wrap.classList.contains('is-selected') &&
        wrap.querySelector('.md-img-fig .md-figcaption')?.textContent === 'Seeded rye' &&
        p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'a selected image written over several lines of HTML is marked',
    run: () => {
      const block = '<p align="center">\n  <img src="assets/loaf.png" alt="Centred" width="400">\n</p>';
      const doc = `Intro.\n\n${block}\n\nAfter.\n`;
      const p = mountShipped(doc);
      const from = doc.indexOf(block);
      // Selecting the paragraph around it takes the image with it.
      p.select(0, from + block.length + 2);
      const ok = wraps(p)[0]?.classList.contains('is-selected') === true && p.doc() === doc;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'Backspace on a selected image deletes the image and nothing else',
    run: () => {
      const image = '![A loaf](assets/rye-loaf.png)';
      const doc = `Before.\n\n${image}\n\nAfter.\n`;
      const p = mountShipped(doc);
      const from = doc.indexOf(image);
      p.select(from, from + image.length);
      const marked = wraps(p)[0]?.classList.contains('is-selected') === true;
      p.press('Backspace');
      const ok = marked && p.doc() === 'Before.\n\n\n\nAfter.\n' && wraps(p).length === 0;
      p.destroy();
      return ok;
    },
  },
];
