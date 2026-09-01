/**
 * Text presentation, shared by the popover (shadow DOM) and the options page.
 *
 * CONTRACT.md Clarifications:
 *   - `error.message` is plain prose with NO markup.
 *   - `error.hint` carries shell commands BARE — "gh auth login", not
 *     "`gh auth login`" — and "the extension is responsible for presentation".
 *
 * So the code formatting happens here, on the client, and it is deliberately
 * exact-match rather than a heuristic regex: a pattern like /\w+ \w+ \w+/ would
 * happily mangle ordinary prose. Strings the extension authors itself may still
 * use backticks, which are also honoured.
 *
 * Nothing here parses HTML. A hostile or malformed bridge message can only ever
 * become text nodes and <code> elements.
 */

import { KNOWN_COMMANDS } from "./errors";

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Longest first, so "gh auth login" wins over a hypothetical "gh auth". */
const COMMAND_RE = new RegExp(
  `(${[...KNOWN_COMMANDS]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join("|")})`,
  "g",
);

const BACKTICK_RE = /`([^`]+)`/g;

function code(text: string, doc: Document): HTMLElement {
  const el = doc.createElement("code");
  el.textContent = text;
  return el;
}

/**
 * Render prose as text nodes plus <code> spans for anything backticked or
 * recognised as a shell command.
 */
export function renderProse(text: string, doc: Document = document): DocumentFragment {
  const frag = doc.createDocumentFragment();

  // Pass 1: backticked spans become <code> verbatim (no command scan inside).
  const byBacktick = text.split(BACKTICK_RE);
  byBacktick.forEach((chunk, backtickIndex) => {
    if (!chunk) return;
    if (backtickIndex % 2 === 1) {
      frag.append(code(chunk, doc));
      return;
    }
    // Pass 2: inside plain prose, wrap bare known commands.
    const byCommand = chunk.split(COMMAND_RE);
    byCommand.forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 1) frag.append(code(part, doc));
      else frag.append(doc.createTextNode(part));
    });
  });

  return frag;
}
