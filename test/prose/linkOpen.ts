import { Scenario, mountProse } from '../harness';
import {
  headingPosition,
  headingSlug,
  linkAddressAt,
  linkHref,
  linkOpenPlan,
  openLink,
  setFragmentHost,
  setLinkHost,
} from '../../src/webview/linkTarget';
import { linkDestination } from '../../src/webview/linkPopover';

/** The address a Cmd-click one character into `needle` would open, as written in the document. */
const addressAt = (doc: string, needle: string): string | null => {
  const p = mountProse(doc);
  const address = linkAddressAt(p.view.state, doc.indexOf(needle) + 1);
  p.destroy();
  return address;
};

/** The address a Cmd-click one character into `needle` actually hands the browser. */
const opens = (doc: string, needle: string): string | null => {
  const address = addressAt(doc, needle);
  return address === null ? null : linkHref(address);
};

export const scenarios: Scenario[] = [
  {
    name: 'Cmd-click opens a bare email address as mailto: and a www. address over https',
    run: () =>
      addressAt('Mail someone@example.com today.', 'someone') === 'someone@example.com' &&
      linkHref('someone@example.com') === 'mailto:someone@example.com' &&
      addressAt('Visit www.example.com now.', 'www') === 'www.example.com' &&
      linkHref('www.example.com') === 'https://www.example.com' &&
      addressAt('Mail <me@example.com>.', 'me@') === 'me@example.com' &&
      linkHref('me@example.com') === 'mailto:me@example.com',
  },
  {
    name: 'Cmd-click leaves addresses with a scheme, relative paths and angle-bracket destinations as written',
    run: () =>
      linkHref('https://example.com/a') === 'https://example.com/a' &&
      linkHref('mailto:me@example.com') === 'mailto:me@example.com' &&
      linkHref('docs/notes.md') === 'docs/notes.md' &&
      linkHref('<my notes.md>') === 'my notes.md' &&
      addressAt('See [the notes](<my notes.md>) here.', 'the notes') === 'my notes.md' &&
      addressAt('Go to <https://x.io/p> now.', 'https') === 'https://x.io/p',
  },
  {
    name: 'Cmd-click on a full, collapsed or shortcut reference link opens the address its definition gives',
    run: () => {
      const doc = 'Read [the reference][ref], [ref][] and [ref].\n\n[Ref]: https://example.com "Title"';
      return (
        addressAt(doc, 'the reference') === 'https://example.com' &&
        addressAt(doc, '[ref][]') === 'https://example.com' &&
        addressAt(doc, '[ref].') === 'https://example.com' &&
        addressAt(doc, 'https://example.com') === 'https://example.com'
      );
    },
  },
  {
    name: 'Cmd-click opens a destination whose parentheses are written as Markdown escapes as the address those escapes stand for',
    run: () =>
      // Balanced parentheses need no escaping and open whole.
      opens('Read [the spec](https://example.com/a_(b)) first.', 'the spec') === 'https://example.com/a_(b)' &&
      opens('Read [the file](<https://example.com/a>) first.', 'the file') === 'https://example.com/a' &&
      // `\(` is Markdown's spelling of a literal `(`, so the address holds the bracket, not the backslash.
      opens('Read [x](https://example.com/a_\\(b\\)) first.', '[x]') === 'https://example.com/a_(b)' &&
      opens('Read [x](<https://example.com/a_\\(b\\)>) first.', '[x]') === 'https://example.com/a_(b)' &&
      opens('Read [x][r] first.\n\n[r]: https://example.com/a_\\(b\\)', '[x]') === 'https://example.com/a_(b)' &&
      // A backslash before anything but punctuation is an ordinary character and stays.
      opens('See [notes](C:\\Users\\me\\notes.md) here.', 'notes]') === 'C:\\Users\\me\\notes.md',
  },
  {
    name: 'a destination the link popover writes is read back as the same address, whatever it holds',
    run: () =>
      ['https://example.com/a_(b)', 'https://example.com/a)b', 'https://example.com/a(b', 'my notes.md', 'https://example.com/a'].every(
        (url) => addressAt(`Read [x](${linkDestination(url, false)}) first.`, '[x]') === url
      ),
  },
  {
    name: 'an address with a scheme is the browser’s to open, as it was before',
    run: () =>
      // Nothing in the suite used to assert what an address opens *as*, only what it
      // resolves to, so these pin the half that must not change.
      JSON.stringify(linkOpenPlan('https://example.com/a')) ===
        JSON.stringify({ kind: 'external', href: 'https://example.com/a' }) &&
      JSON.stringify(linkOpenPlan('mailto:me@example.com')) ===
        JSON.stringify({ kind: 'external', href: 'mailto:me@example.com' }) &&
      // A bare email and a `www.` address gain their scheme first, then open as one.
      JSON.stringify(linkOpenPlan('me@example.com')) ===
        JSON.stringify({ kind: 'external', href: 'mailto:me@example.com' }) &&
      JSON.stringify(linkOpenPlan('www.example.com')) ===
        JSON.stringify({ kind: 'external', href: 'https://www.example.com' }),
  },
  {
    name: 'an address relative to the document goes to the host, which is the only side that knows where the document is',
    run: () =>
      ['signals.md', 'log/2244-11.md', '../maintenance.md', 'fresnel.svg'].every(
        (address) =>
          JSON.stringify(linkOpenPlan(address)) === JSON.stringify({ kind: 'document', address })
      ) &&
      // The fragment travels with the address; the host splits it off to find the file.
      JSON.stringify(linkOpenPlan('signals.md#detections')) ===
        JSON.stringify({ kind: 'document', address: 'signals.md#detections' }) &&
      // Angle brackets and escapes are resolved before the address is handed over.
      JSON.stringify(linkOpenPlan('<my notes.md>')) ===
        JSON.stringify({ kind: 'document', address: 'my notes.md' }),
  },
  {
    name: 'an address that is only a fragment names this document and never leaves the webview',
    run: () =>
      JSON.stringify(linkOpenPlan('#hazard-flags')) ===
        JSON.stringify({ kind: 'fragment', id: 'hazard-flags' }) &&
      JSON.stringify(linkOpenPlan('')) === JSON.stringify({ kind: 'none' }),
  },
  {
    name: 'opening a document address sends it to the host, and opening anything else does not',
    run: () => {
      // The decision and the host's handling are each covered on their own. This is
      // the wire between them, which is the whole of what was missing: the webview
      // has no way to resolve a relative address and has to hand it over.
      const posted: unknown[] = [];
      setLinkHost((message) => posted.push(message));
      try {
        openLink('log/2244-11.md');
        openLink('https://example.com/a');
        openLink('#hazard-flags');
        openLink('javascript:alert(1)');
        return (
          posted.length === 1 &&
          JSON.stringify(posted[0]) ===
            JSON.stringify({ type: 'openLink', address: 'log/2244-11.md' })
        );
      } finally {
        setLinkHost(() => {});
      }
    },
  },
  {
    name: 'a file name followed by a line number is a path, not a scheme',
    run: () =>
      // `signals.md:28` is what Copy ref writes, so reading the part before the colon
      // as a scheme left Sheaf unable to open a reference it had produced itself.
      JSON.stringify(linkOpenPlan('signals.md:28')) ===
        JSON.stringify({ kind: 'document', address: 'signals.md:28' }) &&
      // The address itself reads the same either way. Only where it is sent changed.
      linkHref('signals.md:28') === 'signals.md:28' &&
      // A drive letter has no dot in it, so a Windows path is still the browser's.
      JSON.stringify(linkOpenPlan('C:\\Users\\me\\notes.md')) ===
        JSON.stringify({ kind: 'external', href: 'C:\\Users\\me\\notes.md' }) &&
      // Every scheme spelled without a dot is untouched, including the ones that
      // carry a plus or a hyphen.
      linkOpenPlan('https://example.com/a').kind === 'external' &&
      linkOpenPlan('mailto:me@example.com').kind === 'external' &&
      linkOpenPlan('view-source:https://example.com').kind === 'external' &&
      linkOpenPlan('web+sheaf:x').kind === 'external',
  },
  {
    name: 'a script address is refused however it is spelled',
    run: () =>
      ['javascript:alert(1)', 'JavaScript:alert(1)', ' javascript:alert(1)', 'data:text/html,x', 'vbscript:x'].every(
        (address) => linkOpenPlan(address).kind === 'blocked'
      ) &&
      // Wrapped in angle brackets, which is where a guard that ran before resolving
      // would have let it through.
      linkOpenPlan('<javascript:alert(1)>').kind === 'blocked',
  },
  {
    name: 'a heading answers to the anchor a document already writes for it',
    run: () =>
      // Every fragment in sample/wren-4 is spelled this way, because it is what
      // GitHub and the other renderers produce.
      headingSlug('Hazard flags') === 'hazard-flags' &&
      headingSlug('Work plan') === 'work-plan' &&
      headingSlug('Calibration schedule') === 'calibration-schedule' &&
      headingSlug('Fault codes') === 'fault-codes' &&
      // Punctuation is dropped, and the emphasis markers around a word are syntax.
      headingSlug('Beacon runbook: the beacon will not transmit') ===
        'beacon-runbook-the-beacon-will-not-transmit' &&
      headingSlug('The *signal* year') === 'the-signal-year',
  },
  {
    name: 'a fragment finds the heading it names, and nothing when no heading answers to it',
    run: () => {
      const doc = '# Beacon specification\n\n## Pulse format\n\ntext\n\n## Hazard flags\n\nmore\n';
      const p = mountProse(doc);
      const at = (id: string) => headingPosition(p.view.state, id);
      const found = at('hazard-flags') === doc.indexOf('## Hazard flags');
      const first = at('pulse-format') === doc.indexOf('## Pulse format');
      // A fragment written with the heading's own capitals still lands.
      const loose = at('Hazard-Flags') === doc.indexOf('## Hazard flags');
      const missing = at('no-such-heading') === null;
      p.destroy();
      return found && first && loose && missing;
    },
  },
  {
    name: 'a repeated heading answers to its name with -1, -2 after it, as GitHub numbers them',
    run: () => {
      const doc = '# Notes\n\n## Setup\n\na\n\n## Setup\n\nb\n\n## Setup\n\nc\n';
      const p = mountProse(doc);
      const at = (id: string) => headingPosition(p.view.state, id);
      const heads = [...doc.matchAll(/## Setup/g)].map((m) => m.index);
      const ok = at('setup') === heads[0] && at('setup-1') === heads[1] && at('setup-2') === heads[2] && at('setup-3') === null;
      p.destroy();
      return ok;
    },
  },
  {
    name: 'opening a fragment goes to the heading in this document and never reaches the host',
    run: () => {
      const posted: unknown[] = [];
      const revealed: string[] = [];
      setLinkHost((message) => posted.push(message));
      setFragmentHost((id) => revealed.push(id));
      try {
        openLink('#hazard-flags');
        // A fragment that arrives with a file is the host's: the file has to open first.
        openLink('beacon.md#hazard-flags');
        return (
          JSON.stringify(revealed) === JSON.stringify(['hazard-flags']) &&
          posted.length === 1 &&
          JSON.stringify(posted[0]) ===
            JSON.stringify({ type: 'openLink', address: 'beacon.md#hazard-flags' })
        );
      } finally {
        setLinkHost(() => {});
        setFragmentHost(() => {});
      }
    },
  },
  {
    name: 'Cmd-click on brackets with no matching definition, or a footnote mark, opens nothing',
    run: () =>
      addressAt('See [draft][missing] and [1].\n\n[ref]: https://example.com', 'draft') === null &&
      addressAt('A claim.[^1]\n\n[^1]: A note.', '^1') === null,
  },
];
