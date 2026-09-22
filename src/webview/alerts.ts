/*
 * Alerts: a blockquote that opens with `> [!NOTE]` and reads as a callout.
 *
 * A quote whose first line opens with `[!type]` is drawn with an icon and a
 * label in place of that line and a colour on the quote's rule; everything after
 * the line is the callout's body and renders as it always did.
 *
 * The marker is read in its full form, the one Obsidian writes and GitHub's
 * five types are a subset of: `[!type]`, then an optional `+` or `-` fold
 * marker, then an optional title after whitespace. The type is any name of
 * letters, digits and hyphens, in any case. There are five styles, GitHub's
 * NOTE, TIP, IMPORTANT, WARNING and CAUTION; any other type takes the nearest
 * of them from the alias table below, and an unknown one takes NOTE's. The
 * label is the title when there is one, otherwise the type's name. Folding is
 * presentation only, so a folded callout is drawn open and its `-` is hidden
 * with the rest of the marker.
 *
 * A quote that is not an alert must keep reading as a quote, so the marker has
 * to sit at the very start of the quote's first line with the `!` inside the
 * brackets: `> [draft] notes`, `> [ ] x`, `> [!]`, `> [!NOTE]title` and
 * `[!NOTE]` on a later line are all ordinary text.
 *
 * Nothing here writes to the document. The marker is hidden the same way every
 * other syntax marker is — a replace decoration on lines that are not showing
 * their source — so the caret entering the quote brings `[!NOTE]` back and the
 * bytes on disk never change.
 *
 * The colours are VS Code theme variables rather than the hex values a renderer
 * on the web would use, so a callout is legible in light, dark and high-contrast
 * themes. `media/webview.css` holds which variable stands for which type.
 */

import { Decoration, WidgetType } from '@codemirror/view';
import { Text } from '@codemirror/state';

/** The five alert types. */
export type AlertKind = 'note' | 'tip' | 'important' | 'warning' | 'caution';

/**
 * The label and icon each type is drawn with. The labels are the type names and
 * nothing else, which is what a reader of the Markdown already expects to see.
 *
 * Icons are stroked rather than filled so they stay legible at text size and
 * take their colour from the label around them.
 */
const ALERTS: Record<AlertKind, { label: string; icon: string }> = {
  note: {
    label: 'Note',
    // An `i` in a circle.
    icon: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18M12 11v5M12 7.6h.01',
  },
  tip: {
    label: 'Tip',
    // A light bulb.
    icon: 'M9.5 18.5h5M10.5 21.5h3M12 2.5a6 6 0 0 0-3.5 10.9v2.1h7v-2.1A6 6 0 0 0 12 2.5Z',
  },
  important: {
    label: 'Important',
    // A `!` in a speech bubble.
    icon: 'M4.5 4.5h15v10h-8.5L7 19v-4.5H4.5ZM12 7.3v3.4M12 12.8h.01',
  },
  warning: {
    label: 'Warning',
    // A `!` in a triangle.
    icon: 'M12 3.5 2.6 19.8h18.8ZM12 10v4M12 17h.01',
  },
  caution: {
    label: 'Caution',
    // A `!` in an octagon.
    icon: 'M8.6 3h6.8L20 7.6v6.8L15.4 19H8.6L4 14.4V7.6ZM12 7.6v4.6M12 15.4h.01',
  },
};

/**
 * A quote's first line, from its own `>`, when it opens with a marker: the
 * type, an optional fold marker straight after the `]`, and an optional title
 * after whitespace. Case does not matter, and neither do the spaces either side
 * of the marker.
 */
const MARKER = /^>[ \t]*\[!([a-z0-9][a-z0-9-]*)\]([+-]?)(?:[ \t]+(.*?))?[ \t]*$/i;

/**
 * The style each type outside the five takes: the nearest of them in meaning.
 * A type missing from this table takes NOTE's.
 */
const ALIASES: Record<string, AlertKind> = {
  note: 'note',
  info: 'note',
  todo: 'note',
  abstract: 'note',
  summary: 'note',
  tldr: 'note',
  example: 'note',
  quote: 'note',
  cite: 'note',
  tip: 'tip',
  hint: 'tip',
  success: 'tip',
  check: 'tip',
  done: 'tip',
  question: 'tip',
  help: 'tip',
  faq: 'tip',
  important: 'important',
  warning: 'warning',
  attention: 'warning',
  caution: 'caution',
  danger: 'caution',
  error: 'caution',
  bug: 'caution',
  failure: 'caution',
  fail: 'caution',
  missing: 'caution',
};

/** GitHub's five, which keep the labels they have always had. */
const FIVE = new Set<string>(['note', 'tip', 'important', 'warning', 'caution']);

/** Where an alert's marker sits, which style it takes and what it is called. */
export interface AlertMarker {
  kind: AlertKind;
  /** The title when the marker has one, otherwise the type's name. */
  label: string;
  /** The `[` of the marker. */
  from: number;
  /** The end of the marker's line, so the title and trailing spaces go with it. */
  to: number;
}

/**
 * The marker of the blockquote that starts at `quoteFrom`, or null when that
 * quote is not an alert.
 *
 * `quoteFrom` is the quote's own `>`. Only a quote at the top level is asked:
 * a marker inside a nested quote is ordinary text on GitHub, and its caller
 * leaves it that way here too.
 */
export function alertMarkerAt(doc: Text, quoteFrom: number): AlertMarker | null {
  const line = doc.lineAt(quoteFrom);
  const text = line.text.slice(quoteFrom - line.from);
  const m = MARKER.exec(text);
  if (!m) return null;
  const type = m[1];
  const key = type.toLowerCase();
  const kind = ALIASES[key] ?? 'note';
  const title = m[3] ?? '';
  const name = FIVE.has(key) ? ALERTS[kind].label : type.charAt(0).toUpperCase() + type.slice(1);
  return {
    kind,
    label: title || name,
    from: quoteFrom + text.indexOf('['),
    to: line.to,
  };
}

/** The icon and label drawn in place of an alert's marker line. */
class AlertLabelWidget extends WidgetType {
  constructor(
    readonly kind: AlertKind,
    readonly label: string
  ) {
    super();
  }
  eq(other: AlertLabelWidget): boolean {
    return other.kind === this.kind && other.label === this.label;
  }
  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'md-alert-label';
    span.appendChild(alertIcon(this.kind));
    const name = document.createElement('span');
    name.className = 'md-alert-name';
    name.textContent = this.label;
    span.appendChild(name);
    return span;
  }
  ignoreEvent(): boolean {
    // Let a click place the caret, which is what brings the marker back.
    return false;
  }
}

function alertIcon(kind: AlertKind): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'md-alert-icon');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', ALERTS[kind].icon);
  svg.appendChild(path);
  return svg;
}

const alertLines: Record<AlertKind, Decoration> = {
  note: Decoration.line({ class: 'tok-alert tok-alert-note' }),
  tip: Decoration.line({ class: 'tok-alert tok-alert-tip' }),
  important: Decoration.line({ class: 'tok-alert tok-alert-important' }),
  warning: Decoration.line({ class: 'tok-alert tok-alert-warning' }),
  caution: Decoration.line({ class: 'tok-alert tok-alert-caution' }),
};

/** The line decoration that tints one line of a `kind` alert. */
export function alertLine(kind: AlertKind): Decoration {
  return alertLines[kind];
}

/** The replace decoration that draws an alert's marker line as its icon and label. */
export function alertLabel(marker: AlertMarker): Decoration {
  return Decoration.replace({ widget: new AlertLabelWidget(marker.kind, marker.label) });
}
