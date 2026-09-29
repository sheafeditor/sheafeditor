import { createRequire } from 'node:module';

const {
  planEdit,
  mergeOutsideChange,
  toWebviewText,
  DocumentSync,
  mountWebview,
  RecentTyping,
  RECENT_TYPING_MS,
  noticeAboutLostText,
  quoteLost,
  documentTitle,
  fileTitle,
  relativeLink,
  parseView,
  applyView,
  rowMatches,
  prefillFor,
  setViewKey,
  formatWhere,
  formatSort,
  formatShow,
  setWhereCondition,
  setSortKey,
  hideViewColumn,
  viewKeyValue,
  leadingNumber,
  wholeNumber,
} = createRequire(import.meta.url)('./textSync.bundle.cjs');
import { bootWebview } from './webview.mjs';

/** The text two changes make together, with nothing of either dropped. */
const merged = (base, mine, theirs) => {
  const { text, dropped } = mergeOutsideChange(base, mine, theirs);
  return dropped ? null : text;
};

/** The text two changes make together when part of the other one could not be kept. */
const mergedWithLoss = (base, mine, theirs) => {
  const { text, dropped } = mergeOutsideChange(base, mine, theirs);
  return dropped ? text : null;
};

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
    /** Whether each of those documents was said to take back text the person typed. */
    took: [],
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
    setContent(next, tookTypedText) {
      doc.posted.push(next);
      doc.took.push(tookTypedText === true);
    },
    onEdited() {},
  };
  return doc;
}

/**
 * The recent-typing window, on a clock the check moves itself. `clock.now` is the
 * time it reads, so a check can step past the window instead of waiting out ten real
 * seconds.
 */
const recently = (clock = { now: 1_000 }) => new RecentTyping(RECENT_TYPING_MS, () => clock.now);

/** A small datatable for the view checks, with ties, empties, currency and ISO dates. */
const TASKS_HEADER = ['Feature', 'Status', 'Estimate', 'Owner', 'Due'];
const TASKS = [
  ['Login', 'Done', '3', 'Sam', '2024-03-01'],
  ['Search', 'In progress', '10', 'Ann', '2024-01-15'],
  ['Export', 'Todo', '9', 'Sam', ''],
  ['Import', 'todo', '$1,200', '', '2023-12-31'],
  ['Sync', 'Blocked', '', 'Sam', '2024-02-10'],
];

/** The source rows a view body shows over the tasks table, in display order. */
const viewRows = (body, header = TASKS_HEADER, rows = TASKS) => applyView(parseView(body), header, rows).rows;
/** The rows a `from` plus one `where` line shows over the tasks table. */
const whereRows = (where, header, rows) => viewRows(`from: tasks.csv\nwhere: ${where}`, header, rows);

/** Say why a check failed, above the line naming it, and report the failure. */
const fail = (why) => {
  console.log(`   ${why}`);
  return false;
};

/**
 * The character range in `before` that a change is allowed to rewrite: the whole of every line
 * the change touches, and nothing past them. A grapheme or a line ending can force an edit to
 * reach a little wider than the characters that differ, which is why this is measured in lines
 * rather than characters.
 */
function linesThatChanged(before, after) {
  let pre = 0;
  while (pre < before.length && pre < after.length && before[pre] === after[pre]) pre++;
  let post = 0;
  while (
    post < before.length - pre &&
    post < after.length - pre &&
    before[before.length - 1 - post] === after[after.length - 1 - post]
  ) {
    post++;
  }
  const start = before.lastIndexOf('\n', pre - 1) + 1;
  const lastChanged = Math.max(0, before.length - post - 1);
  const ending = before.indexOf('\n', lastChanged);
  return { start, end: ending === -1 ? before.length : ending + 1 };
}

const cases = [
  // The one rule stated as absolute: the file is the document, so an edit carries the change
  // and nothing else. Every other check in this file would also fail if this broke, but each of
  // them is named after a symptom (an emoji, a line ending, text a person lost), so this one
  // exists to put the rule itself in the first line of the failure.
  ['the invariant: an edit rewrites the lines that changed and leaves every other line alone', () => {
    const body = 'First line.\n\n## A heading\n\nA paragraph in the middle of the file.\n\n- one\n- two\n\nLast line.\n';
    const changes = [
      ['one letter typed mid-paragraph', body, body.replace('the middle', 'the middlle')],
      ['one letter deleted mid-paragraph', body, body.replace('paragraph', 'paragaph')],
      ['a line inserted between two others', body, body.replace('- two', '- two\n- three')],
      ['a line deleted from the middle', body, body.replace('- one\n', '')],
      ['a word changed on the first line', body, body.replace('First', 'Second')],
      ['a word changed on the last line', body, body.replace('Last', 'Final')],
      ['an emoji swapped mid-file', body.replace('- one', '- 😀'), body.replace('- one', '- 😃')],
      ['a heading rewritten whole', body, body.replace('## A heading', '### Another heading entirely')],
    ];
    return changes.every(([what, before, after]) => {
      const edit = planEdit(before, after, false);
      if (!edit) return fail(`${what}: no edit was planned for a change`);
      const allowed = linesThatChanged(before, after);
      if (applied(before, edit) !== after) return fail(`${what}: the edit does not produce the text`);
      if (edit.start < allowed.start || edit.end > allowed.end) {
        return fail(
          `${what}: the edit rewrites characters ${edit.start} to ${edit.end}, ` +
            `and the lines that changed are ${allowed.start} to ${allowed.end}`
        );
      }
      return true;
    });
  }],
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
  ['two changes in different places are put together, whichever comes first', () => {
    const base = 'Alpha\nBeta\nGamma\n';
    // The person typed in the first line; something else rewrote the third.
    const mine = 'Alpha!\nBeta\nGamma\n';
    const theirs = 'Alpha\nBeta\nGamma rewritten\n';
    const both = 'Alpha!\nBeta\nGamma rewritten\n';
    // And the same the other way round: the person in the third, the other in the first.
    const lateMine = 'Alpha\nBeta\nGamma!\n';
    const earlyTheirs = 'Alpha rewritten\nBeta\nGamma\n';
    return (
      merged(base, mine, theirs) === both &&
      merged(base, lateMine, earlyTheirs) === 'Alpha rewritten\nBeta\nGamma!\n'
    );
  }],
  ['a change put together with one that added or removed text ahead of it lands where the person typed it', () => {
    const base = 'one\ntwo\nthree\n';
    // The other change is longer than what it replaced, so everything after it moves.
    const grew = merged(base, 'one\ntwo\nthree!\n', 'one and a half\ntwo\nthree\n');
    // And shorter, so everything after it moves back.
    const shrank = merged(base, 'one\ntwo\nthree!\n', 'o\ntwo\nthree\n');
    return grew === 'one and a half\ntwo\nthree!\n' && shrank === 'o\ntwo\nthree!\n';
  }],
  ['nothing to put together when only one side changed, or both made the same change', () => {
    const base = 'Alpha\n';
    return (
      merged(base, 'Alpha!\n', base) === 'Alpha!\n' &&
      merged(base, base, 'Alpha?\n') === 'Alpha?\n' &&
      merged(base, 'Alpha!\n', 'Alpha!\n') === 'Alpha!\n'
    );
  }],
  ['two changes to the same characters leave the person’s, and say something was dropped', () => {
    const base = 'Start\n';
    return (
      // Both replaced the first word.
      mergedWithLoss(base, 'Started\n', 'Starting\n') === 'Started\n' &&
      // Both inserted at the very same point, where there is no answer to which is first.
      mergedWithLoss(base, 'StartQ\n', 'Started differently\n') === 'StartQ\n' &&
      // One inside the other's span.
      mergedWithLoss('abcdef\n', 'abXYZf\n', 'aQf\n') === 'abXYZf\n'
    );
  }],
  ['a paragraph deleted beside the line being typed in stays deleted', () => {
    /*
     * The write is behind on the typed line, as every write made from a file read a
     * moment ago is, and it deletes a paragraph next to it. Nothing unchanged sits
     * between the two, so a diff that knows only whether lines are equal reads the
     * deletion and the typed line as one range, which then disagrees with the person's
     * typing and is dropped whole. The agent is told nothing and believes it removed a
     * paragraph that is still there.
     *
     * All four positions, because the one that worked did so only by having an
     * untouched paragraph in between to anchor on.
     */
    const base = 'Top line.\n\nMiddle line.\n\nBoZZttom line.\n';
    const typedLast = 'Top line.\n\nMiddle line.\n\nBoZZYYttom line.\n';
    // The paragraph directly above it, from a write behind on the typed line.
    const below = mergedWithLoss(base, typedLast, 'Top line.\n\nBottom line.\n');
    // Two paragraphs away, from a write that had already seen the typing, so nothing
    // of theirs is dropped at all.
    const above = merged(base, typedLast, 'Middle line.\n\nBoZZttom line.\n');
    const typedFirst = 'ToZZYYp line.\n\nMiddle line.\n\nBottom line.\n';
    const under = mergedWithLoss('ToZZp line.\n\nMiddle line.\n\nBottom line.\n', typedFirst, 'Top line.\n\nBottom line.\n');
    return (
      below === 'Top line.\n\nBoZZYYttom line.\n' &&
      above === 'Middle line.\n\nBoZZYYttom line.\n' &&
      under === 'ToZZYYp line.\n\nBottom line.\n'
    );
  }],
  ['two unrelated lines are not read as one line changed', () => {
    // The control for matching a line against the same line changed. Two lines that
    // merely end alike are a line gone and a line arrived, and treating them as one
    // would put half of somebody's sentence into the other's.
    const base = 'Alpha line.\n\nMiddle line.\n\nOmega line.\n';
    return (
      // `Middle line.` and `Bottom line.` share only " line.", which is under the
      // share a changed line has to keep, so this is a deletion and an addition.
      merged(base, 'Alpha line!\n\nMiddle line.\n\nOmega line.\n', 'Alpha line.\n\nBottom line.\n\nOmega line.\n') ===
        'Alpha line!\n\nBottom line.\n\nOmega line.\n' &&
      // And a blank line is never the same line as one with words on it.
      merged('a\n\nb\n', 'a!\n\nb\n', 'a\nwords here now\nb\n') === 'a!\nwords here now\nb\n'
    );
  }],
  ['a write stale on the line being typed keeps everything else it changed', () => {
    /*
     * The case an agent actually produces, and the one all-or-nothing got wrong. It
     * read the file a moment ago, so its copy is behind on the line being typed in
     * and current everywhere else. Settling that one line used to throw away the
     * whole write; now it costs only the line it is about.
     */
    const base = 'Top line.\n\nMiZddle line.\n\nBottom line.\n';
    const mine = 'Top line.\n\nMiZZYYddle line.\n\nBottom line.\n';
    const theirs = 'Top line changed by an agent.\n\nMiddle line.\n\nBottom line.\n';
    return (
      mergedWithLoss(base, mine, theirs) ===
      'Top line changed by an agent.\n\nMiZZYYddle line.\n\nBottom line.\n'
    );
  }],
  ['a write that changed two places at once keeps both, with the person typing between them', () => {
    // What an agent actually does: one write, several places. A single span from the
    // first place to the last covers the line the person is typing in, so comparing
    // whole spans refused this outright and the agent's whole write was lost.
    const base = 'Alpha\n| a | Open |\nBeta\n| b | Open |\nGamma\n';
    const mine = 'Alpha\n| a | Open |\nBeta!\n| b | Open |\nGamma\n';
    const theirs = 'Alpha\n| a | Done |\nBeta\n| b | Done |\nGamma\n';
    return merged(base, mine, theirs) === 'Alpha\n| a | Done |\nBeta!\n| b | Done |\nGamma\n';
  }],
  ['one side rewriting the line under the other’s is put together, not refused', () => {
    // Line ranges that meet are two changes to two lines. Refusing those would
    // refuse most of what this is for.
    const base = 'one\ntwo\nthree\n';
    return merged(base, 'one\ntwo!\nthree\n', 'one rewritten\ntwo\nthree\n') === 'one rewritten\ntwo!\nthree\n';
  }],
  ['a line added on each side at the same place keeps both lines, whole', () => {
    // Two additions at one line are each no lines wide, so nothing says which comes
    // first and the line merge steps aside. The character merge then keeps both,
    // because each addition ends in a newline and so neither lands inside the other.
    // An order had to be picked; what matters is that no line comes out mangled.
    const base = 'one\ntwo\n';
    return merged(base, 'one\nmine\ntwo\n', 'one\ntheirs\ntwo\n') === 'one\nmine\ntheirs\ntwo\n';
  }],
  ['two changes inside one line are still put together, character by character', () => {
    // A line both sides changed falls to the finer merge rather than being refused:
    // an agent rewriting one cell of a row while the person types in another.
    const base = '| Login | Open | Sam |\n';
    return merged(base, '| Login | Open | Sammy |\n', '| Login | Done | Sam |\n') === '| Login | Done | Sammy |\n';
  }],
  ['two changes to the same characters of one line leave the person’s', () => {
    // The control for the line above. Same line, same characters, so neither merge
    // has an answer and the person at the keyboard keeps theirs.
    const base = '| Login | Open | Sam |\n';
    return (
      mergedWithLoss(base, '| Login | Opened | Sam |\n', '| Login | Done | Sam |\n') ===
      '| Login | Opened | Sam |\n'
    );
  }],
  ['a document rewritten from top to bottom is past the size the line merge attempts', () => {
    // Every line differs, which is more pairs of lines than the line diff will build a
    // table for, so it steps aside and the character merge answers. A line the person
    // added past the end of it is clear of that rewrite and survives; anything they
    // typed inside it is not, and they keep their own text.
    const wide = (mark) => Array.from({ length: 2100 }, (_, i) => `line ${i} ${mark}`).join('\n') + '\n';
    const inside = wide('a').replace('line 1000 a', 'line 1000 a!');
    return (
      merged(wide('a'), wide('a') + 'typed\n', wide('b')) === wide('b') + 'typed\n' &&
      mergedWithLoss(wide('a'), inside, wide('b')) === inside
    );
  }],
  ['an edit the editor refuses is planned again, and an outside write it was refused for is kept', async () => {
    const doc = makeHost('Start\n');
    const sync = new DocumentSync(doc.host);
    // The document moves between the plan and the write, which is what makes VS Code
    // refuse the edit the person's keystroke went into.
    doc.beforeApply = () => doc.write('Start\nwritten from outside\n');
    await sync.edit('StartQ\n');
    // Both changes are in the file. The person's Q went in where they typed it, and
    // the line somebody else wrote is still there: replanning used to take it out,
    // because the text the webview sent was read before that line existed.
    //
    // And the webview is given the result. It sent text that predates the other
    // change, so leaving it alone would put the file a version ahead of the page.
    return (
      doc.refused === 1 &&
      doc.applied === 1 &&
      doc.text === 'StartQ\nwritten from outside\n' &&
      doc.posted.length === 1 &&
      doc.posted[0] === doc.text
    );
  }],
  ['an outside write to the same characters the person is typing leaves the person’s text standing', async () => {
    const doc = makeHost('Start\n');
    const sync = new DocumentSync(doc.host);
    // Both changed the first line, so there is nothing to put together and the
    // person at the keyboard keeps theirs. Nothing tells them yet, which is the
    // half of this that is still to be written.
    doc.beforeApply = () => doc.write('Started differently\n');
    await sync.edit('StartQ\n');
    // The page is told too, so it is not left showing a document the file disagrees with.
    return doc.refused === 1 && doc.applied === 1 && doc.text === 'StartQ\n' && doc.posted[0] === 'StartQ\n';
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
  // The rest drive the real webview, `src/webview/main.ts`, and hand it the file's own
  // bytes. The host converts line endings before it posts, but the webview must not
  // depend on that: CodeMirror reads a carriage return as a line break whoever sent it.
  ['real webview, CRLF file: a change from outside shows the file’s lines, keeps the caret, and the next keystroke writes only itself', () =>
    outsideChangeThenKeystroke({
      before: 'First line.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n',
      after: 'First line changed.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n',
      crlf: true,
      caretIn: 'Third',
      typeIn: 'Second',
      want: 'First line changed.\r\n\r\nSeZcond line.\r\n\r\nThird line.\r\n',
    })],
  ['real webview, LF file: a change from outside shows the file’s lines, keeps the caret, and the next keystroke writes only itself', () =>
    outsideChangeThenKeystroke({
      before: 'First line.\n\nSecond line.\n\nThird line.\n',
      after: 'First line changed.\n\nSecond line.\n\nThird line.\n',
      crlf: false,
      caretIn: 'Third',
      typeIn: 'Second',
      want: 'First line changed.\n\nSeZcond line.\n\nThird line.\n',
    })],
  ['real webview, CRLF file with no final line ending: a change from outside adds no line and no ending', () =>
    outsideChangeThenKeystroke({
      before: 'First line.\r\n\r\nSecond line.\r\n\r\nThird line.',
      after: 'First line changed.\r\n\r\nSecond line.\r\n\r\nThird line.',
      crlf: true,
      caretIn: 'Third',
      typeIn: 'Second',
      want: 'First line changed.\r\n\r\nSeZcond line.\r\n\r\nThird line.',
    })],
  ['real webview, mixed line endings: a change from outside leaves every other line ending as the file has it', () =>
    outsideChangeThenKeystroke({
      before: 'One.\r\nTwo.\nThree.\rFour.\r\n',
      after: 'One changed.\r\nTwo.\nThree.\rFour.\r\n',
      crlf: true,
      caretIn: 'Four',
      typeIn: 'Two',
      want: 'One changed.\r\nTwZo.\nThree.\rFour.\r\n',
    })],
  ['real webview, CRLF file: the document the host posts after a write from outside reaches the webview as a minimal change', async () => {
    // The host's own path: the write from outside goes through the sync, which posts
    // what the webview should hold. Nothing here hands the webview a carriage return.
    const doc = makeHost('First line.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n', { crlf: true });
    const sync = new DocumentSync(doc.host);
    const webview = bootWebview((m) => m.type === 'edit' && void sync.edit(m.text));
    webview.init(toWebviewText(doc.text));
    webview.click(webview.doc().indexOf('Third') + 2);
    doc.write('First line changed.\r\n\r\nSecond line.\r\n\r\nThird line.\r\n');
    sync.documentChanged(doc.text);
    for (const text of doc.posted) webview.setContent(text);
    const caretKept = webview.caret() === webview.doc().indexOf('Third') + 2;
    webview.click(webview.doc().indexOf('Second') + 2);
    webview.type('Z');
    await settle();
    const lines = webview.lines();
    webview.close();
    return (
      same(lines, ['First line changed.', '', 'SeZcond line.', '', 'Third line.', '']) &&
      caretKept &&
      doc.text === 'First line changed.\r\n\r\nSeZcond line.\r\n\r\nThird line.\r\n' &&
      doc.applied === 1
    );
  }],
  ['real webview: a letter handed back by the host mid-burst keeps its place in the word', async () => {
    // The person is typing `Z2` after `Z1`. Between the two letters the host posts the
    // document twice: once a step behind, without the `Z` the person has just typed,
    // and once with it, as its own write of that letter lands. The second one inserts
    // the `Z` exactly where the caret is sitting, and where the caret goes then is what
    // decides the order the next letter comes out in.
    const webview = bootWebview();
    webview.init('Some words.\n');
    webview.click(7); // Inside "words", after "wo".
    webview.type('Z');
    webview.type('1');
    webview.type('Z');
    webview.setContent('Some woZ1rds.\n');
    webview.setContent('Some woZ1Zrds.\n');
    webview.type('2');
    const doc = webview.doc();
    const caret = webview.caret();
    webview.close();
    return doc === 'Some woZ1Z2rds.\n' && caret === 11;
  }],
  ['real webview: a final newline added on the way to disk leaves the caret on the line it was on', () => {
    // `files.insertFinalNewline` puts a newline on the end of a file that has none,
    // and the person is typing at that end, so the newline arrives exactly where the
    // caret is. A line break is the one thing arriving text must not put itself in
    // front of the caret for: doing that moves the person onto the next line, and the
    // rest of what they were writing goes there with them.
    const webview = bootWebview();
    webview.init('No newline at the end');
    webview.click('No newline at the end'.length);
    webview.type(' A');
    webview.setContent('No newline at the end A\n');
    webview.type(' B');
    const doc = webview.doc();
    webview.close();
    return doc === 'No newline at the end A B\n';
  }],

  /*
   * What the person typed in the last few seconds, and what a write from outside took
   * of it. A clock of its own, so the window is a number these checks set rather than
   * how long the suite happens to take.
   */
  ['lost text: a write made from text read before the keystroke names what it took', () => {
    const typing = recently();
    typing.record('Some words.\n');
    return typing.dropped('Some woZZrds.\n', 'Some words.\nAdded by a tool.\n') === 'ZZ';
  }],
  ['lost text: a write that keeps what was typed takes nothing', () => {
    const typing = recently();
    typing.record('Some words.\n');
    return typing.dropped('Some woZZrds.\n', 'Some woZZrds.\nAdded by a tool.\n') === undefined;
  }],
  ['lost text: a write to a part of the file the person never touched takes nothing', () => {
    const typing = recently();
    typing.record('Intro.\n\nSome words.\n');
    return typing.dropped('Intro.\n\nSome woZZrds.\n', 'Intro changed.\n\nSome woZZrds.\n') === undefined;
  }],
  ['lost text: a write with nothing typed before it takes nothing', () => {
    return recently().dropped('Some words.\n', 'Other words.\n') === undefined;
  }],
  ['lost text: typing that has fallen out of the window is no longer something a write can take', () => {
    const clock = { now: 1_000 };
    const typing = recently(clock);
    typing.record('Some words.\n');
    clock.now += RECENT_TYPING_MS + 1;
    return typing.dropped('Some woZZrds.\n', 'Some words.\n') === undefined;
  }],
  ['lost text: the keystroke before the window closes still counts', () => {
    const clock = { now: 1_000 };
    const typing = recently(clock);
    typing.record('Some words.\n');
    clock.now += RECENT_TYPING_MS - 1;
    return typing.dropped('Some woZZrds.\n', 'Some words.\n') === 'ZZ';
  }],
  ['lost text: only the part of the typing the write did not keep is named', () => {
    const typing = recently();
    typing.record('Row: \n');
    // The write kept the line and everything on it up to `ab`, and dropped the rest.
    return typing.dropped('Row: abcd\n', 'Row: ab\n') === 'cd';
  }],
  ['lost text: a write that takes only whitespace says nothing', () => {
    const typing = recently();
    typing.record('Start\n');
    return typing.dropped('Start   \n', 'Start\n') === undefined;
  }],
  ['lost text: text deleted and then written back by the tool is not something taken', () => {
    const typing = recently();
    typing.record('Some words.\n');
    // The person deleted `words`; the write from outside puts it back. Nothing of
    // theirs is in the file to lose.
    return typing.dropped('Some .\n', 'Some words.\n') === undefined;
  }],
  ['lost text: what is on record is forgotten once a document from outside has landed', () => {
    const typing = recently();
    typing.record('Some words.\n');
    typing.forget();
    return typing.dropped('Some woZZrds.\n', 'Some words.\n') === undefined;
  }],
  ['lost text: the notice quotes what was taken and says which key brings it back', () => {
    return (
      noticeAboutLostText('ZZ') ===
      'Sheaf: this file changed outside the editor, and your last change is gone: "ZZ". Undo brings it back.'
    );
  }],
  /*
   * What a document calls itself, for the words of a link written to it.
   *
   * Both hosts answer that question and they read it with this one function, so the cases
   * that matter are the ones where a `#` in the text is not the title: inside front matter,
   * inside a fenced block, and a heading deeper than `#` when that is where the document
   * starts.
   */
  ['doc title: the first heading is the title, at any level, and the file name is the fallback', () => {
    const cases = [
      ['# Launch plan\n\nBody.\n', 'Launch plan'],
      ['## Launch plan\n\nBody.\n', 'Launch plan'],
      ['###### Launch plan\n', 'Launch plan'],
      // A closed ATX heading's trailing hashes are syntax.
      ['## Launch plan ##\n', 'Launch plan'],
      ['   # Launch plan\n', 'Launch plan'],
      // Four spaces is an indented code block, not a heading.
      ['    # Launch plan\n\n# Real one\n', 'Real one'],
      // No hash, no heading: `#Launch` is a word starting with a hash.
      ['#Launch plan\n\n# Real one\n', 'Real one'],
      ['Body with no heading.\n', 'release-notes'],
      ['', 'release-notes'],
      // An empty heading names nothing, so the next one, or the file, does.
      ['#\n\n# Real one\n', 'Real one'],
      ['#  \n', 'release-notes'],
    ];
    const bad = cases.filter(([text, want]) => documentTitle(text, 'docs/release-notes.md') !== want);
    return bad.length === 0 || fail(`these gave the wrong title: ${JSON.stringify(bad.map((c) => [c[0], c[1], documentTitle(c[0], 'docs/release-notes.md')]))}`);
  }],
  ['doc title: front matter and fenced code hold no title, however many hashes they carry', () => {
    const front = '---\ntitle: Not this\n# not a heading either\n---\n\n# Launch plan\n';
    const fenced = '```sh\n# install it\n```\n\n# Launch plan\n';
    const tildes = '~~~\n# comment\n~~~\n\n# Launch plan\n';
    // An unclosed fence is not front matter, so the document is read from the top.
    const unclosed = '---\n# Launch plan\n';
    // A fence closed with more markers than it opened with is still closed.
    const longer = '```\n# no\n`````\n\n# Launch plan\n';
    const got = [front, fenced, tildes, unclosed, longer].map((t) => documentTitle(t, 'a/plan.md'));
    const want = ['Launch plan', 'Launch plan', 'Launch plan', 'Launch plan', 'Launch plan'];
    return got.join('|') === want.join('|') || fail(`got ${JSON.stringify(got)}`);
  }],
  ['doc link: an address is written relative to the folder the document sits in', () => {
    // One reading for three callers: the completion after `(`, and each host answering a
    // pasted path. Two of them writing different addresses for one file would be the same
    // fact written twice, which is what moving this out of the completion was for.
    const cases = [
      ['docs/notes.md', 'docs/plan.md', 'plan.md'],
      ['docs/notes.md', 'plan.md', '../plan.md'],
      ['docs/a/notes.md', 'docs/b/plan.md', '../b/plan.md'],
      ['notes.md', 'docs/plan.md', 'docs/plan.md'],
      ['docs/a/b/notes.md', 'plan.md', '../../../plan.md'],
      // A sibling gets no `./`: Markdown needs none and nobody writes one by hand.
      ['notes.md', 'plan.md', 'plan.md'],
      ['/ws/docs/notes.md', '/ws/plan.md', '../plan.md'],
    ];
    const bad = cases.filter(([from, to, want]) => relativeLink(from, to) !== want);
    return bad.length === 0 || fail(`these gave the wrong address: ${JSON.stringify(bad.map((c) => [c[0], c[1], c[2], relativeLink(c[0], c[1])]))}`);
  }],
  ['doc title: the file-name fallback takes the extension off and invents nothing else', () => {
    const got = [
      fileTitle('docs/release-notes.md'),
      fileTitle('release notes.markdown'),
      fileTitle('/a/b/plan.md'),
      fileTitle('C:\\notes\\plan.md'),
      fileTitle('plan'),
      // A dotfile is its own name rather than an empty one.
      fileTitle('.plan.md'),
    ];
    const want = ['release-notes', 'release notes', 'plan', 'plan', 'plan', '.plan'];
    return got.join('|') === want.join('|') || fail(`got ${JSON.stringify(got)}`);
  }],
  ['lost text: a long quote is cut short, and a quote spanning lines is shown on one', () => {
    const long = quoteLost('x'.repeat(200));
    return long === `${'x'.repeat(60)}…` && quoteLost(' one\ntwo  three ') === 'one two three';
  }],
  ['lost text: the document that took it is the one the webview is told to make undoable', () => {
    const doc = makeHost('Some words.\n');
    const sync = new DocumentSync(doc.host);
    doc.write('Other words.\n');
    const reached = sync.documentChanged(doc.text, true);
    return reached === true && same(doc.posted, ['Other words.\n']) && same(doc.took, [true]);
  }],
  ['lost text: a document the webview already holds is not pushed and is not said to have taken anything', () => {
    const doc = makeHost('Some words.\n');
    const sync = new DocumentSync(doc.host);
    return sync.documentChanged(doc.text, true) === false && doc.posted.length === 0;
  }],

  // View blocks: the query layer, with no rendering.
  ['cell numbers: the column sort reading is shared, currency, separators and signs included', () => {
    return (
      leadingNumber('$1,200') === 1200 &&
      leadingNumber('−12 apples') === -12 &&
      leadingNumber('.5') === 0.5 &&
      leadingNumber('apples') === null &&
      wholeNumber('50%') === 50 &&
      wholeNumber('12 apples') === null
    );
  }],
  ['view: a full body parses every key, keys case-insensitive and spaces around the colon tolerated', () => {
    const q = parseView('  FROM :  tasks.csv  \n\nWhere: status != Done; owner = Sam\nsort: estimate desc, feature\nshow: feature, status, estimate\nlayout: Board\ngroup: status\n');
    return (
      q.from === 'tasks.csv' &&
      same(q.where.map((c) => [c.column, c.op, c.value]), [['status', '!=', 'Done'], ['owner', '=', 'Sam']]) &&
      same(q.sort.map((s) => [s.column, s.descending]), [['estimate', true], ['feature', false]]) &&
      same(q.show, ['feature', 'status', 'estimate']) &&
      q.layout === 'board' &&
      q.group === 'status' &&
      q.errors.length === 0
    );
  }],
  ['view: a named inline block is kept as written, and absent keys take their defaults', () => {
    const q = parseView('from: #tasks');
    return q.from === '#tasks' && q.where.length === 0 && q.sort.length === 0 && q.show === null && q.layout === 'table' && q.group === null && q.errors.length === 0;
  }],
  ['view: column names may hold spaces in where, sort and show', () => {
    const q = parseView('from: t.csv\nwhere: due date is empty; next step contains call\nsort: due date desc\nshow: due date, next step');
    return (
      same(q.where.map((c) => [c.column, c.op, c.value]), [['due date', 'is empty', ''], ['next step', 'contains', 'call']]) &&
      same(q.sort.map((s) => [s.column, s.descending]), [['due date', true]]) &&
      same(q.show, ['due date', 'next step'])
    );
  }],
  ['view: a quoted value holds a semicolon and keeps its outer spaces', () => {
    const q = parseView('from: t.csv\nwhere: note = "a;b"; note contains " x "; title = "say ""hi"""');
    return same(q.where.map((c) => c.value), ['a;b', ' x ', 'say "hi"']) && q.errors.length === 0;
  }],
  ['view: an unknown key is an error on its line, and the rest still parses', () => {
    const q = parseView('from: tasks.csv\nfilter: status = Done\nsort: estimate');
    return (
      same(q.errors, [{ line: 1, key: 'filter', message: 'Unknown key "filter". A view understands from, where, sort, show, layout and group.' }]) &&
      q.from === 'tasks.csv' &&
      same(q.sort.map((s) => s.column), ['estimate'])
    );
  }],
  ['view: a missing from is an error on the whole block', () => {
    const q = parseView('sort: estimate\n');
    return same(q.errors, [{ line: null, key: 'from', message: 'A view needs a "from" line that names its table, like "from: tasks.csv" or "from: #tasks".' }]) && q.from === null;
  }],
  ['view: a board with no group is an error on the layout line', () => {
    const q = parseView('from: t.csv\nlayout: board');
    return same(q.errors, [{ line: 1, key: 'layout', message: 'A board needs a column to group its cards by. Add a line like "group: status".' }]);
  }],
  ['view: an unknown layout, a line with no key and a repeated key are each errors, and the first key wins', () => {
    const q = parseView('from: t.csv\nlayout: grid\njust words\nsort: a\nsort: b');
    return (
      same(q.errors.map((e) => [e.line, e.key]), [[1, 'layout'], [2, null], [4, 'sort']]) &&
      q.errors[0].message === 'Unknown layout "grid". A view\'s layout is table or board.' &&
      q.layout === 'table' &&
      same(q.sort.map((s) => s.column), ['a'])
    );
  }],
  ['view: a condition with no operator, or no value, is an error and the other conditions still hold', () => {
    const q = parseView('from: t.csv\nwhere: status Done; owner =; estimate > 3');
    return (
      same(q.errors.map((e) => e.line), [1, 1]) &&
      q.errors[0].message.startsWith('Can\'t read the condition "status Done".') &&
      q.errors[1].message === 'The condition "owner =" needs a value after "=". To find blank cells, write "owner is empty".' &&
      same(q.where.map((c) => [c.column, c.op, c.value]), [['estimate', '>', '3']])
    );
  }],
  ['view: parsing never throws, whatever the body holds', () => {
    const bodies = ['', '\n\n', ':', 'where:', 'where: ;;;', 'where: "unclosed', 'sort: ,, desc', 'from:', '\r\n\r', 'show:'];
    return bodies.every((b) => {
      try {
        return Array.isArray(parseView(b).errors);
      } catch {
        return false;
      }
    });
  }],
  ['view where: = and != compare text case-insensitively', () => {
    return same(whereRows('status = todo'), [2, 3]) && same(whereRows('status != Done'), [1, 2, 3, 4]);
  }],
  ['view where: <, <=, > and >= compare numbers as numbers, and an empty cell matches none of them', () => {
    return (
      same(whereRows('estimate > 9'), [1, 3]) &&
      same(whereRows('estimate >= 9'), [1, 2, 3]) &&
      same(whereRows('estimate < 9'), [0]) &&
      same(whereRows('estimate <= 9'), [0, 2])
    );
  }],
  ['view where: contains, is empty and is not empty', () => {
    return (
      same(whereRows('feature CONTAINS or'), [2, 3]) &&
      same(whereRows('owner is empty'), [3]) &&
      same(whereRows('owner Is Not Empty'), [0, 1, 2, 4])
    );
  }],
  ['view where: 10 > 9 and $1,200 > 30 read as numbers, apple < Banana reads as text', () => {
    const nums = [['9'], ['10'], ['$1,200'], ['30']];
    const fruit = [['apple'], ['Banana'], ['cherry']];
    return (
      same(whereRows('n > 9', ['n'], nums), [1, 2, 3]) &&
      same(whereRows('n > 30', ['n'], nums), [2]) &&
      same(whereRows('name < Banana', ['Name'], fruit), [0]) &&
      same(whereRows('name = BANANA', ['Name'], fruit), [1])
    );
  }],
  ['view where: ISO dates compare in date order', () => {
    return same(whereRows('due < 2024-02-01'), [1, 3]) && same(whereRows('due >= 2024-02-10'), [0, 4]);
  }],
  ['view where: a quoted value matches a cell holding a semicolon', () => {
    return same(whereRows('note = "a;b"', ['Note'], [['a;b'], ['a'], ['b']]), [0]);
  }],
  ['view: a where, sort, show or group naming a missing column is an error naming the columns, and the rest applies', () => {
    const q = parseView('from: t.csv\nwhere: priority = 1; status = todo\nsort: size, estimate desc\nshow: feature, nope, status\nlayout: board\ngroup: team');
    const v = applyView(q, TASKS_HEADER, TASKS);
    return (
      same(v.rows, [3, 2]) &&
      same(v.columns, [0, 1]) &&
      v.group === null &&
      same(v.errors.map((e) => [e.line, e.key]), [[1, 'where'], [2, 'sort'], [3, 'show'], [5, 'group']]) &&
      v.errors[0].message === 'No column is named "priority". The columns are Feature, Status, Estimate, Owner and Due.'
    );
  }],
  ['view: a group naming a real column resolves to its index', () => {
    return applyView(parseView('from: t.csv\nlayout: board\ngroup: STATUS'), TASKS_HEADER, TASKS).group === 1;
  }],
  ['view sort: numbers as numbers, empty cells last in either direction', () => {
    return (
      same(viewRows('from: t.csv\nsort: estimate'), [0, 2, 1, 3, 4]) &&
      same(viewRows('from: t.csv\nsort: estimate desc'), [3, 1, 2, 0, 4])
    );
  }],
  ['view sort: several keys, the second breaking ties in the first, desc on one', () => {
    return same(viewRows('from: t.csv\nsort: owner, estimate desc'), [1, 2, 0, 4, 3]);
  }],
  ['view sort: ties keep their source order, ascending and descending', () => {
    return same(viewRows('from: t.csv\nsort: status'), [4, 0, 1, 2, 3]) && same(viewRows('from: t.csv\nsort: status desc'), [2, 3, 1, 0, 4]);
  }],
  ['view sort: slashed dates sort as dates when the column settles their order', () => {
    return same(viewRows('from: t.csv\nsort: d', ['D'], [['2/3/2024'], ['12/31/2023'], ['1/15/2024']]), [1, 2, 0]);
  }],
  ['view: show picks columns in the order written, and absent shows them all in file order', () => {
    return (
      same(applyView(parseView('from: t.csv\nshow: estimate, FEATURE'), TASKS_HEADER, TASKS).columns, [2, 0]) &&
      same(applyView(parseView('from: t.csv'), TASKS_HEADER, TASKS).columns, [0, 1, 2, 3, 4])
    );
  }],
  ['view: applying a view never changes the table it reads', () => {
    const header = TASKS_HEADER.slice();
    const rows = TASKS.map((r) => r.slice());
    const before = JSON.stringify([header, rows]);
    applyView(parseView('from: t.csv\nwhere: status != Done\nsort: estimate desc\nshow: owner'), header, rows);
    return JSON.stringify([header, rows]) === before;
  }],
  ['view: a new row is prefilled with what the = conditions require', () => {
    const q = parseView('from: t.csv\nwhere: status = Todo; owner = Sam; estimate > 3; nope = x');
    return same(prefillFor(q, TASKS_HEADER), ['', 'Todo', '', 'Sam', '']);
  }],
  ['view: an edited row is checked against the filter on its own', () => {
    const q = parseView('from: t.csv\nwhere: status != Done; owner = Sam');
    return rowMatches(q, TASKS_HEADER, TASKS[2]) === true && rowMatches(q, TASKS_HEADER, TASKS[0]) === false && rowMatches(q, TASKS_HEADER, TASKS[1]) === false;
  }],
  ['view header: the filter, sort and columns format back into lines that parse the same', () => {
    const q = parseView('from: t.csv\nwhere: note = "a;b"; owner is empty; pad contains " x "; t = "say ""hi"""\nsort: due date desc, feature\nshow: due date, feature');
    const again = parseView(`from: t.csv\nwhere: ${formatWhere(q.where)}\nsort: ${formatSort(q.sort)}\nshow: ${formatShow(q.show)}`);
    return (
      formatWhere(q.where) === 'note = "a;b"; owner is empty; pad contains " x "; t = "say ""hi"""' &&
      formatSort(q.sort) === 'due date desc, feature' &&
      same(again.where, q.where.map((c) => ({ ...c }))) &&
      same(again.sort, q.sort) &&
      same(again.show, q.show)
    );
  }],
  ['view header: setting a key rewrites only its line, keeping its spelling and spacing', () => {
    return setViewKey('from: t.csv\nSort:  a\nshow: x\n', 'sort', 'b desc') === 'from: t.csv\nSort:  b desc\nshow: x\n';
  }],
  ['view header: a key that is absent is appended after the last line, before trailing blank lines', () => {
    return (
      setViewKey('from: t.csv\n', 'sort', 'a') === 'from: t.csv\nsort: a\n' &&
      setViewKey('from: t.csv\n\n', 'sort', 'a') === 'from: t.csv\nsort: a\n\n' &&
      setViewKey('from: t.csv', 'sort', 'a') === 'from: t.csv\nsort: a' &&
      setViewKey('', 'from', 't.csv') === 'from: t.csv'
    );
  }],
  ['view header: CRLF bodies keep CRLF on replaced, appended and neighbouring lines', () => {
    return (
      setViewKey('from: t.csv\r\nsort: a\r\n', 'sort', 'b') === 'from: t.csv\r\nsort: b\r\n' &&
      setViewKey('from: t.csv\r\nshow: x\r\n', 'sort', 'a') === 'from: t.csv\r\nshow: x\r\nsort: a\r\n' &&
      setViewKey('from: t.csv\r\nshow: x', 'sort', 'a') === 'from: t.csv\r\nshow: x\r\nsort: a'
    );
  }],
  ['view header: removing a key drops its line and keeps the final-newline state', () => {
    return (
      setViewKey('from: t.csv\nsort: a\nshow: x\n', 'sort', null) === 'from: t.csv\nshow: x\n' &&
      setViewKey('from: t.csv\nsort: a', 'sort', null) === 'from: t.csv' &&
      setViewKey('from: t.csv\r\nsort: a\r\n', 'SORT', null) === 'from: t.csv\r\n' &&
      setViewKey('from: t.csv\n', 'sort', null) === 'from: t.csv\n'
    );
  }],
  ['view header: a header filter changes its own condition and leaves every other condition as written', () => {
    const body = 'from: t.csv\nWhere:  owner=Sam ;status != Done;  note = "a;b"\nsort: x\n';
    return (
      // Updated in place, keeping the column's spelling and the spaces around the part.
      setWhereCondition(body, 'STATUS', { op: 'contains', value: 'Op' }) ===
        'from: t.csv\nWhere:  owner=Sam ;status contains Op;  note = "a;b"\nsort: x\n' &&
      // Added after the others.
      setWhereCondition(body, 'estimate', { op: 'is empty', value: '' }) ===
        'from: t.csv\nWhere:  owner=Sam ;status != Done;  note = "a;b"; estimate is empty\nsort: x\n' &&
      // Taken out, the rest untouched.
      setWhereCondition(body, 'status', null) === 'from: t.csv\nWhere:  owner=Sam ;  note = "a;b"\nsort: x\n' &&
      // A value needing quotes is quoted.
      setWhereCondition('from: t.csv\n', 'note', { op: '=', value: 'x; y' }) === 'from: t.csv\nwhere: note = "x; y"\n' &&
      // The last condition taken out takes the line with it; a column with none changes nothing.
      setWhereCondition('from: t.csv\nwhere: a = 1\nsort: b\n', 'a', null) === 'from: t.csv\nsort: b\n' &&
      setWhereCondition(body, 'nobody', null) === body
    );
  }],
  ['view header: a click sorts by one column, a Shift-click changes or adds one key and leaves the others as written', () => {
    const body = 'from: t.csv\nsort: Status  asc, estimate desc\n';
    return (
      setSortKey(body, 'feature', 'asc', false) === 'from: t.csv\nsort: feature\n' &&
      setSortKey(body, 'estimate', null, false) === 'from: t.csv\n' &&
      setSortKey(body, 'estimate', 'asc', true) === 'from: t.csv\nsort: Status  asc, estimate\n' &&
      setSortKey(body, 'feature', 'desc', true) === 'from: t.csv\nsort: Status  asc, estimate desc, feature desc\n' &&
      setSortKey(body, 'status', null, true) === 'from: t.csv\nsort: estimate desc\n' &&
      setSortKey('from: t.csv', 'a', 'desc', true) === 'from: t.csv\nsort: a desc'
    );
  }],
  ['view header: hiding a column takes its name off show, or writes show from the columns shown', () => {
    return (
      hideViewColumn('from: t.csv\nshow:  feature,Status , estimate\n', 'status', ['feature', 'status', 'estimate']) ===
        'from: t.csv\nshow:  feature, estimate\n' &&
      hideViewColumn('from: t.csv\n', 'status', ['feature', 'status', 'estimate']) === 'from: t.csv\nshow: feature, estimate\n' &&
      // The last column shown stays: a view with no columns shows nothing.
      hideViewColumn('from: t.csv\nshow: a\n', 'a', ['a']) === 'from: t.csv\nshow: a\n' &&
      viewKeyValue('from: t.csv\nSHOW :  a, b \n', 'show') === 'a, b' &&
      viewKeyValue('from: t.csv\n', 'show') === null
    );
  }],
];

/** Let the sync's queued writes land: each crosses a turn. */
function settle() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A file open in the real webview is rewritten from outside, and the webview is handed
 * the new bytes as they are on disk. Then the person types Z two characters into the
 * word `typeIn`. Holds when the webview shows exactly the file's lines, the caret is
 * still two characters into `caretIn`, the change came in as the smallest edit rather
 * than a whole-document replace, and the file afterwards is `want`: the new bytes plus
 * the Z and nothing else.
 */
async function outsideChangeThenKeystroke({ before, after, crlf, caretIn, typeIn, want }) {
  const doc = makeHost(before, { crlf });
  const sync = new DocumentSync(doc.host);
  const writes = [];
  const applyEdit = doc.host.applyEdit;
  doc.host.applyEdit = (start, end, replacement) => {
    writes.push({ start, end, replacement });
    return applyEdit(start, end, replacement);
  };
  const webview = bootWebview((m) => m.type === 'edit' && void sync.edit(m.text));
  webview.init(before);
  const shown = toWebviewText(after);
  const caretAt = (text) => text.indexOf(caretIn) + 2;
  webview.click(caretAt(webview.doc()));
  doc.write(after);
  webview.setContent(after);
  const lines = webview.lines();
  const caret = webview.caret();
  const echoed = webview.edits().length;
  webview.click(webview.doc().indexOf(typeIn) + 2);
  webview.type('Z');
  await settle();
  webview.close();
  return (
    same(lines, shown.split('\n')) &&
    caret === caretAt(shown) &&
    // A change from outside is not the person's edit, so nothing goes back to the host.
    echoed === 0 &&
    doc.text === want &&
    same(writes, [{ start: after.indexOf(typeIn) + 2, end: after.indexOf(typeIn) + 2, replacement: 'Z' }])
  );
}

let passed = 0;
for (const [name, check] of cases) {
  if (await check()) passed++;
  else console.log(`❌ ${name}`);
}
console.log(`${passed}/${cases.length} sync checks passed`);
process.exit(passed === cases.length ? 0 : 1);
