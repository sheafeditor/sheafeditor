/*
 * The names of the events on the document stream, declared once for both ends of it.
 *
 * `server.ts` writes them and `host.ts` reads them, in two different runtimes: one is Node
 * serving a folder, the other is a script in a browser tab. A string literal in each is two
 * declarations of one fact with nothing comparing them, which is the shape every defect in this
 * host's wire has had so far, so the names live here and both sides import them.
 *
 * ## Why a whole document arrives under two names rather than one name and a flag
 *
 * A frame carries the document as one `data:` line per line of it, because that is how the
 * event-stream format spells a newline. Every one of those lines is the person's own text, so
 * there is nowhere in the body to put a flag they could not also have typed: a `data:` line
 * reading `tookTypedText: true` is indistinguishable from a document that says so.
 *
 * The event name is the one part of the frame that is ours rather than theirs. So the flag is
 * the name, and a reader dispatches on it the way the format intends.
 */

/** A document from disk that took nothing the person had just typed. */
export const SET_CONTENT = 'setContent';

/**
 * A document from disk that took something the person had just typed.
 *
 * What it buys is that the editor annotates the change as the person's own, so one press of
 * their own Undo brings their text back. Without it an outside write reached the editor marked
 * as somebody else's ordinary edit: nothing said anything had gone, and Undo did not offer it.
 *
 * Deliberately not a prefix of the other name. A reader written as
 * `startsWith('event: setContent')` matches both, and would then read the flag off a frame it
 * had already decided was the flagless kind.
 */
export const SET_CONTENT_TOOK_TYPED = 'contentTookTypedText';

/**
 * Something to tell the person, with an offer to undo what it describes.
 *
 * Its `data:` lines are the message rather than a document, which is why it is its own event
 * and not a field on the one above: that frame's body is the person's own text, line for line,
 * and there is no room in it for a sentence of ours they could not also have typed.
 *
 * The words are built on the server, from the same functions the extension host uses, so the
 * two hosts cannot come to describe one event differently.
 */
export const NOTICE = 'notice';
