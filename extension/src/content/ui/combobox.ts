/**
 * A non-native, searchable single-select combobox.
 *
 * WHY NOT `<select>` — a native select cannot be filtered, and with a dozen
 * workspaces the Target picker was a scroll-and-squint exercise. Its popup is
 * also drawn by the OS, so nothing about it can be styled, measured or driven
 * from a test.
 *
 * WHY IT LIVES IN THE POPOVER'S OWN SHADOW ROOT, IN NORMAL FLOW — two reasons,
 * both load-bearing:
 *
 *   1. `containKeyboard()` is attached to the popover's shadow host, and it is
 *      what keeps Graphite's and GitHub's single-key shortcut layers from
 *      eating characters typed into our surfaces (see ui/keyboard.ts). A
 *      dropdown portalled into its own host next to <body> would be a *new*
 *      surface accepting text input, and would need its own containment. Being
 *      a child of the card means the search input inherits it for free.
 *   2. `.card` is `overflow: hidden` so its rounded corners clip the header and
 *      footer fills. An absolutely-positioned panel would be clipped by that.
 *
 * The cost of normal flow is that opening the panel changes the card's height,
 * which is the input to `Popover.position()`. Hence `onResize`: every state
 * change that alters our height reports it, and the popover re-anchors. The
 * card is separately height-capped in styles.ts so it can never grow past the
 * viewport.
 *
 * ESC AND CLICK-OUTSIDE ARE LAYERED BY THE POPOVER, NOT HERE. The popover owns
 * a *document-level capturing* keydown listener, which by construction runs
 * before the event has even descended into the shadow tree — a listener on the
 * search input could never win the race. So the popover asks us first
 * (`handleEscape()`, `containsPath()`) and only acts on the outer layer if we
 * did not consume the event. One decision, in one place, in the right order.
 */

import { el } from "./dom";

export interface ComboboxOption {
  /** Row text, shown verbatim in the list and on the closed trigger. */
  label: string;
  /**
   * The haystack the query is matched against, pre-joined by the caller. Not
   * derived from `label`: a candidate is searchable by things the label does not
   * spell out (a bare PR number, "create", …).
   */
  search: string;
}

export interface ComboboxInit {
  options: ComboboxOption[];
  /** Index of the committed option; shown on the trigger and `aria-selected`. */
  selected: number;
  /** Accessible name for the trigger and the listbox. */
  label: string;
  searchPlaceholder: string;
  /** Rendered when the query matches nothing. */
  emptyText: string;
  /** Extra attributes for the trigger, e.g. the `data-stp-*` test hooks. */
  triggerAttrs?: Record<string, string>;
  /** Commit. The caller is expected to re-render, discarding this instance. */
  onCommit: (index: number) => void;
  /** Our height changed; whoever positions us should re-measure. */
  onResize?: () => void;
}

let uid = 0;

export class Combobox {
  readonly root: HTMLElement;

  private readonly init: ComboboxInit;
  private readonly trigger: HTMLButtonElement;
  private readonly panel: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly list: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly optionIdPrefix: string;

  private expanded = false;
  /** Indices into `init.options` currently passing the filter, in order. */
  private visible: number[] = [];
  /** Active option as an index into `init.options`; -1 when nothing is active. */
  private active = -1;

  constructor(init: ComboboxInit) {
    this.init = init;
    const n = ++uid;
    const listId = `stp-combo-list-${n}`;
    this.optionIdPrefix = `stp-combo-opt-${n}-`;

    this.root = el("div", { class: "combo", "data-stp-combobox": "", "data-stp-combo-open": "false" });

    // The caret is drawn by CSS (::after) rather than appended as a node, so
    // `trigger.textContent` is exactly the committed option's label — which is
    // what both a screen reader and the e2e suite read.
    this.trigger = el(
      "button",
      {
        type: "button",
        class: "combo-trigger",
        "aria-haspopup": "listbox",
        "aria-expanded": "false",
        "aria-controls": listId,
        "aria-label": init.label,
        ...(init.triggerAttrs ?? {}),
      },
      [init.options[init.selected]?.label ?? ""],
    ) as HTMLButtonElement;

    this.input = el("input", {
      type: "text",
      class: "combo-search",
      role: "combobox",
      "aria-expanded": "true",
      "aria-controls": listId,
      "aria-autocomplete": "list",
      "aria-label": `Search ${init.label.toLowerCase()}`,
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: "false",
      placeholder: init.searchPlaceholder,
      "data-stp-combo-search": "",
    }) as HTMLInputElement;

    this.list = el("div", {
      id: listId,
      class: "combo-list",
      role: "listbox",
      "aria-label": init.label,
      "data-stp-combo-list": "",
    });

    // Deliberately a sibling of the listbox, not a child: a `role="listbox"`
    // whose children are not `role="option"` is invalid ARIA, and an
    // unselectable "no matches" row is not an option.
    this.empty = el(
      "div",
      { class: "combo-empty", role: "status", "data-stp-combo-empty": "", hidden: "" },
      [init.emptyText],
    );

    this.panel = el("div", { class: "combo-panel", "data-stp-combo-panel": "", hidden: "" }, [
      this.input,
      this.list,
      this.empty,
    ]);

    this.root.append(this.trigger, this.panel);
    this.wire();
  }

  /* ---------------------------------------------------------------------- */
  /* state                                                                   */
  /* ---------------------------------------------------------------------- */

  get isOpen(): boolean {
    return this.expanded;
  }

  /** True when `event.composedPath()` runs through this widget. */
  containsPath(path: EventTarget[]): boolean {
    return path.includes(this.root);
  }

  open(seedQuery = ""): void {
    if (this.expanded) return;
    this.expanded = true;
    this.root.setAttribute("data-stp-combo-open", "true");
    this.trigger.setAttribute("aria-expanded", "true");
    this.panel.removeAttribute("hidden");
    this.input.value = seedQuery;
    // Open on the committed option, so ArrowDown/ArrowUp start from where the
    // user actually is rather than from the top of the list.
    this.refilter(this.init.selected);
    this.input.focus();
    this.init.onResize?.();
    this.revealPanel();
  }

  /**
   * Close without committing. `focusTrigger` returns focus to the trigger, which
   * is what Esc and Shift+Tab want; a commit does not, because the caller
   * re-renders and moves focus onward itself.
   */
  close(focusTrigger = false): void {
    if (!this.expanded) return;
    this.expanded = false;
    this.root.setAttribute("data-stp-combo-open", "false");
    this.trigger.setAttribute("aria-expanded", "false");
    this.panel.setAttribute("hidden", "");
    this.input.value = "";
    this.input.removeAttribute("aria-activedescendant");
    // Options only exist while open. Nothing can read a stale list, and a test
    // that queries options is forced to drive the real widget to get them.
    this.list.replaceChildren();
    this.visible = [];
    this.active = -1;
    if (focusTrigger) this.trigger.focus();
    this.init.onResize?.();
  }

  /**
   * Escape, offered to us first by the popover. Returns true when we consumed
   * it — i.e. the dropdown was open and is now closed and the popover must stay
   * open. A second Escape finds us closed, returns false, and closes the card.
   */
  handleEscape(): boolean {
    if (!this.expanded) return false;
    this.close(true);
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /* events                                                                  */
  /* ---------------------------------------------------------------------- */

  private wire(): void {
    this.trigger.addEventListener("click", () => {
      if (this.expanded) this.close(true);
      else this.open();
    });

    this.trigger.addEventListener("keydown", (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter" || e.key === " ") {
        // preventDefault also suppresses the synthetic click a button fires for
        // Enter/Space, which would otherwise immediately toggle us shut again.
        e.preventDefault();
        this.open();
        if (e.key === "ArrowUp") this.move(-1);
        return;
      }
      // Type-to-search from the closed trigger, like a native select's
      // type-ahead — except it opens the filtered list instead of jumping.
      if (e.key.length === 1) {
        e.preventDefault();
        this.open(e.key);
      }
    });

    this.input.addEventListener("input", () => this.refilter());

    this.input.addEventListener("keydown", (e) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          this.move(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          this.move(-1);
          break;
        case "Home":
          e.preventDefault();
          this.setActive(this.visible[0] ?? -1);
          break;
        case "End":
          e.preventDefault();
          this.setActive(this.visible[this.visible.length - 1] ?? -1);
          break;
        case "Enter":
          e.preventDefault();
          this.commitActive();
          break;
        case "Tab":
          // Documented behaviour: Tab commits the active option and lets the
          // caller move focus on to the next field; Shift+Tab retreats to the
          // trigger without committing. Either way focus leaves the panel, so
          // leaving it open would strand a dropdown over the rest of the form.
          e.preventDefault();
          if (e.shiftKey) this.close(true);
          else this.commitActive();
          break;
        default:
          break;
      }
    });
  }

  /* ---------------------------------------------------------------------- */
  /* list                                                                    */
  /* ---------------------------------------------------------------------- */

  /**
   * Rebuild the visible rows for the current query.
   *
   * `preferActive` is the option to leave active if it survived the filter;
   * otherwise the first match wins, so Enter after typing always commits
   * something sensible.
   */
  private refilter(preferActive = this.active): void {
    const query = this.input.value;
    this.visible = this.init.options
      .map((_, i) => i)
      .filter((i) => comboMatches(query, this.init.options[i]!.search));

    this.list.replaceChildren();
    for (const i of this.visible) {
      const opt = this.init.options[i]!;
      const row = el(
        "div",
        {
          id: `${this.optionIdPrefix}${i}`,
          class: "combo-option",
          role: "option",
          "aria-selected": String(i === this.init.selected),
          "data-stp-combo-option": "",
          "data-stp-index": String(i),
        },
        [opt.label],
      );
      // Commit on click, but keep focus in the search input: a pointerdown that
      // blurs the input would fire before the click and could reorder the
      // popover's own pointerdown bookkeeping.
      row.addEventListener("mousedown", (e) => e.preventDefault());
      row.addEventListener("click", () => this.commit(i));
      row.addEventListener("mouseenter", () => this.setActive(i));
      this.list.append(row);
    }

    const none = this.visible.length === 0;
    this.empty.toggleAttribute("hidden", !none);
    this.list.toggleAttribute("hidden", none);

    this.setActive(this.visible.includes(preferActive) ? preferActive : (this.visible[0] ?? -1));
    this.init.onResize?.();
  }

  private setActive(index: number): void {
    this.active = index;
    for (const node of this.list.children) {
      const row = node as HTMLElement;
      if (Number(row.dataset.stpIndex) === index) row.setAttribute("data-stp-active", "true");
      else row.removeAttribute("data-stp-active");
    }
    if (index < 0) {
      this.input.removeAttribute("aria-activedescendant");
      return;
    }
    this.input.setAttribute("aria-activedescendant", `${this.optionIdPrefix}${index}`);
    const row = this.list.querySelector<HTMLElement>(`[data-stp-index="${index}"]`);
    if (row) scrollIntoViewWithin(this.list, row);
  }

  /** Move the active option by `delta`, wrapping at both ends. */
  private move(delta: number): void {
    if (!this.visible.length) return;
    const at = this.visible.indexOf(this.active);
    const len = this.visible.length;
    const next = at === -1 ? (delta > 0 ? 0 : len - 1) : (at + delta + len) % len;
    this.setActive(this.visible[next]!);
  }

  private commitActive(): void {
    // An empty result set must not silently commit anything: the selection the
    // user already had stands, and Enter is a no-op.
    if (this.active < 0) return;
    this.commit(this.active);
  }

  private commit(index: number): void {
    this.close();
    this.init.onCommit(index);
  }

  /**
   * Keep the whole panel inside the card's scrolling body after it opens. Done
   * with explicit scroll arithmetic rather than `scrollIntoView()`, which is
   * free to scroll *any* ancestor — including the host page, which would move
   * Graphite's or GitHub's document under the user because they opened a
   * dropdown.
   */
  private revealPanel(): void {
    const body = this.root.closest<HTMLElement>(".body");
    if (body) scrollIntoViewWithin(body, this.panel);
  }
}

/**
 * Substring match, case-insensitive, all tokens required.
 *
 * Whitespace splits the query into tokens that each have to appear *somewhere*
 * in the haystack, in any order — so "auth stack" finds the stack workspace
 * whose slug contains "auth" without the user having to know the exact order
 * the label happens to concatenate things in.
 */
export function comboMatches(query: string, haystack: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const hay = haystack.toLowerCase();
  return tokens.every((t) => hay.includes(t));
}

/**
 * Scroll `container` the minimum amount that makes `child` fully visible.
 *
 * Measured off client rects rather than `offsetTop`, whose reference frame is
 * the nearest *positioned* ancestor and therefore differs between the list
 * (position: relative) and the card body (static).
 */
function scrollIntoViewWithin(container: HTMLElement, child: HTMLElement): void {
  const cr = container.getBoundingClientRect();
  const r = child.getBoundingClientRect();
  const top = r.top - cr.top + container.scrollTop;
  const bottom = top + r.height;
  if (top < container.scrollTop) container.scrollTop = top;
  else if (bottom > container.scrollTop + container.clientHeight) {
    container.scrollTop = bottom - container.clientHeight;
  }
}
