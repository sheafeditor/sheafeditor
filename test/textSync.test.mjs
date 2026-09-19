import { createRequire } from 'node:module';

const { planEdit, toWebviewText, DocumentSync, mountWebview } =
  createRequire(import.meta.url)('./textSync.bundle.cjs');

/** The document text the planned edit produces when VS Code applies it. */
function applied(documentText, edit) {
  return documentText.slice(0, edit.start) + edit.replacement + documentText.slice(edit.end);
}

/**
 * True when every surrogate in the text is half of a pair. A lone surrogate cannot be
 * encoded, so one in a replacement reaches the file as U+FFFD.
 */
function wellFormed(text) {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 0xdc00 && code <= 0xdfff) return false; // A low half with no high before it.
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i++;
    }
  }
  return true;
}

/** An edit is sound when it is well-formed, lands on the wanted text, and touches `span` code units. */
function sound(documentText, webviewText, span) {
  const e = planEdit(documentText, webviewText, false);
  return (
    !!e &&
    wellFormed(e.replacement) &&
    wellFormed(documentText.slice(0, e.start)) &&
    wellFormed(documentText.slice(e.end)) &&
    applied(documentText, e) === webviewText &&
    e.end - e.start === span
  );
}

/**
 * The document the sync writes to, with VS Code's rule that an edit prepared against
 * a document that has changed since is refused: `_validateBeforePrepare` throws "has
 * changed in the meantime" and `applyEdit` resolves false. The rule is driven here by
 * the document's version against the version the host read the text at, so a test of
 * it settles the same way every run rather than depending on when a promise lands.
 */
function makeHost(text, { crlf = false } = {}) {
  const doc = {
    text,
    version: 0,
    /** The version the host last read the text at, which each edit is planned against. */
    readAt: -1,
    applied: 0,
    refused: 0,
    /** Every document the host has posted to the webview. */
    posted: [],
    /** Runs before every edit is written, for a file something else keeps writing to. */
    beforeEveryApply: null,
    /** Runs once, just before the next edit is written. */
    beforeApply: null,
    /** Runs once, just after the next edit is written. */
    afterApply: null,
    /** A write from outside: another editor, a formatter, a pull. */
    write(next) {
      doc.text = next;
      doc.version++;
    },
  };
  const once = (name) => {
    const hook = doc[name];
    if (!hook) return;
    doc[name] = null;
    hook();
  };
  doc.host = {
    getText() {
      doc.readAt = doc.version;
      return doc.text;
    },
    crlf: () => crlf,
    async applyEdit(start, end, replacement) {
      const plannedAt = doc.readAt;
      if (doc.beforeEveryApply) doc.beforeEveryApply();
      once('beforeApply');
      await Promise.resolve(); // The write crosses a turn, as the real one does.
      if (doc.version !== plannedAt) {
        doc.refused++;
        return false;
      }
      doc.text = doc.text.slice(0, start) + replacement + doc.text.slice(end);
      doc.version++;
      doc.applied++;
      once('afterApply');
      return true;
    },
    setContent(next) {
      doc.posted.push(next);
    },
    onEdited() {},
  };
  return doc;
}

const cases = [
  ['identical text is no edit', () => planEdit('x\n', 'x\n', false) === null],
  ['LF document: one typed character is a one-character edit', () => {
    const e = planEdit('a\nb\n', 'a\nbc\n', false);
    return e?.start === 3 && e.end === 3 && e.replacement === 'c';
  }],
  ['CRLF document: one typed character is a one-character edit', () => {
    const e = planEdit('a\r\nb\r\nz\r\n', 'a\nbc\nz\n', true);
    return e?.start === 4 && e.end === 4 && e.replacement === 'c' && e.text === 'a\r\nbc\r\nz\r\n';
  }],
  ['CRLF document: an added line is written with CRLF', () => {
    const e = planEdit('a\r\nb\r\n', 'a\nnew\nb\n', true);
    return e?.start === 3 && e.end === 3 && e.replacement === 'new\r\n';
  }],
  ['CRLF document: text differing only in line endings is no edit', () => planEdit('a\r\nb\r\n', 'a\nb\n', true) === null],
  ['one emoji replaced by another is a whole-character edit', () => sound('Face 😀 here\n', 'Face 😃 here\n', 2)],
  ['an emoji that differs in its first half is replaced whole', () => sound('😀x\n', '🨀x\n', 2)],
  ['a flag replaced by another flag rewrites the letter that changed', () => sound('🇫🇷 flag\n', '🇫🇮 flag\n', 2)],
  ['the last person in a family emoji is replaced with the rest of the sequence left alone', () => sound('a 👨‍👩‍👧 b\n', 'a 👨‍👩‍👦 b\n', 2)],
  ['an emoji typed in front of another is inserted, not written over it', () => sound('a😀\n', 'a😃😀\n', 0)],
  ['a letter under a combining mark is replaced with the mark left alone', () => sound('é acute\n', 'á acute\n', 1)],
  ['CRLF document: an emoji swap is still a whole-character edit', () => {
    const e = planEdit('Face 😀 here\r\n', 'Face 😃 here\n', true);
    return e?.start === 5 && e.end === 7 && e.replacement === '😃' && e.text === 'Face 😃 here\r\n';
  }],
  ['a second keystroke arriving mid-edit is written, not refused', async () => {
    const doc = makeHost('Start\n');
    const sync = new DocumentSync(doc.host);
    // Two edits posted back to back. Planned at the same time, the second is
    // prepared against text the first has already replaced and VS Code drops it.
    const first = sync.edit('Start a\n');
    const second = sync.edit('Start ab\n');
    await Promise.all([first, second]);
    return doc.text === 'Start ab\n' && doc.refused === 0 && doc.posted.length === 0;
  }],
  ['a fast burst leaves the webview holding everything the document holds', async () => {
    const doc = makeHost('Start\n');
    const sync = new DocumentSync(doc.host);
    const webview = mountWebview('Start\n');
    const typed = ' the quick brown fox jumps over the lazy dog 0123456789';
    const writes = [];
    for (let i = 0; i < typed.length; i++) {
      writes.push(sync.edit(webview.replaceRange(5 + i, 5 + i, typed[i])));
    }
    await Promise.all(writes);
    for (const text of doc.posted) webview.setContent(text);
    return doc.text === `Start${typed}\n` && webview.doc() === doc.text;
  }],
  ['an edit the editor refuses is planned again, not dropped', async () => {
    const doc = makeHost('Start\n');
    const sync = new DocumentSync(doc.host);
    // The document moves between the plan and the write, which is what makes VS Code
    // refuse the edit the person's keystroke went into.
    doc.beforeApply = () => doc.write('Start\nwritten from outside\n');
    await sync.edit('StartQ\n');
    return doc.refused === 1 && doc.applied === 1 && doc.text === 'StartQ\n' && doc.posted.length === 0;
  }],
  ['an edit refused over and over stops being replanned and the webview is resynced', async () => {
    const doc = makeHost('Start\n');
    const sync = new DocumentSync(doc.host);
    // Something else writes the file continuously, so every plan is already stale by
    // the time it is handed over and no attempt can ever land.
    let writes = 0;
    doc.beforeEveryApply = () => doc.write(`Start\nwritten from outside ${++writes}\n`);
    await sync.edit('StartQ\n');
    return (
      doc.applied === 0 &&
      doc.refused === 9 && // One attempt, then REPLAN_LIMIT more.
      doc.text === `Start\nwritten from outside ${writes}\n` &&
      doc.posted.length === 1 &&
      doc.posted[0] === doc.text
    );
  }],
  ['a change from outside during a burst reaches the webview once the burst lands', async () => {
    const doc = makeHost('Start\n');
    const sync = new DocumentSync(doc.host);
    doc.afterApply = () => doc.write(`${doc.text}written from outside\n`);
    await sync.edit('Start a\n');
    return (
      doc.text === 'Start a\nwritten from outside\n' &&
      doc.posted.length === 1 &&
      doc.posted[0] === doc.text
    );
  }],
  ['a burst, a pause, then another burst keeps the letters in the order they were typed', async () => {
    const doc = makeHost('Some words.\n');
    const sync = new DocumentSync(doc.host);
    const webview = mountWebview('Some words.\n');
    webview.click(7); // Inside "words", after "wo".
    let posted = 0;
    const burst = async (keys) => {
      await Promise.all(keys.map((key) => sync.edit(webview.type(key))));
      const arrived = doc.posted.splice(0);
      posted += arrived.length;
      for (const text of arrived) webview.setContent(text);
    };
    await burst(['Z', '1']);
    await burst(['Z', '2']);
    // Nothing was posted back, so the caret never moved out from under the typing.
    return (
      doc.text === 'Some woZ1Z2rds.\n' &&
      webview.doc() === doc.text &&
      webview.caret() === 11 &&
      posted === 0
    );
  }],
  ['a document arriving from the host replaces a whole emoji, never half of one', () => {
    const webview = mountWebview('Face 😀 here\n');
    webview.setContent('Face 😃 here\n');
    const change = webview.lastChange();
    // The two halves of the pair are the same code unit apart in both texts, so a trim
    // that counts code units alone stops between them. The host and the webview have to
    // agree about where the edit begins, and this is where they would drift apart.
    const plan = planEdit('Face 😀 here\n', 'Face 😃 here\n', false);
    return (
      webview.doc() === 'Face 😃 here\n' &&
      change.from === 5 &&
      change.to === 7 &&
      change.from === plan.start &&
      change.to === plan.end &&
      change.insert === plan.replacement
    );
  }],
  ['the webview is sent every line ending as a newline', () =>
    toWebviewText('a\r\nb\rc\nd\r\n') === 'a\nb\nc\nd\n'],
  ['CRLF document: a change from outside does not add a line to the webview', () => {
    const webview = mountWebview(toWebviewText('First line.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n'));
    webview.setContent(toWebviewText('First line changed.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n'));
    return webview.doc() === 'First line changed.\n\nSecond line.\n\nThird line.\n';
  }],
  ['CRLF document: the keystroke after a change from outside writes only the keystroke', async () => {
    const doc = makeHost('First line.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n', { crlf: true });
    const sync = new DocumentSync(doc.host);
    const webview = mountWebview(toWebviewText(doc.text));
    doc.write('First line changed.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n');
    sync.documentChanged(doc.text);
    for (const text of doc.posted) webview.setContent(text);
    // Type Z into "Second", the way the report does.
    await sync.edit(webview.replaceRange(23, 23, 'Z'));
    return (
      doc.text === 'First line changed.\r\n\r\nSeZcond line.\r\n\r\nThird line.\r\n' &&
      doc.applied === 1
    );
  }],
  ['a lone carriage return is left alone by an edit elsewhere', async () => {
    const doc = makeHost('one\rtwo\nthree\n');
    const sync = new DocumentSync(doc.host);
    const webview = mountWebview(toWebviewText(doc.text));
    await sync.edit(webview.replaceRange(13, 13, '!'));
    return doc.text === 'one\rtwo\nthree!\n';
  }],
  ['mixed line endings: an edit rewrites the line it touched and no other', () => {
    const e = planEdit('a\r\nb\nc\rd\n', 'a\nb\nc\nd!\n', false);
    return e?.start === 8 && e.end === 8 && e.replacement === '!' && e.text === 'a\r\nb\nc\rd!\n';
  }],
];

let passed = 0;
for (const [name, check] of cases) {
  if (await check()) passed++;
  else console.log(`❌ ${name}`);
}
console.log(`${passed}/${cases.length} sync checks passed`);
process.exit(passed === cases.length ? 0 : 1);
