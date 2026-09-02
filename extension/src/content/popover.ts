/**
 * The composer popover: shadow-DOM card anchored to the injected button.
 *
 * Flow (PLAN.md §4):
 *   open -> POST /v1/resolve immediately (before the user types)
 *        -> show resolved target + a dropdown of every candidate
 *        -> autofocused textarea, provider dropdown pre-set to the default
 *        -> Cmd/Ctrl+Enter sends, Esc closes
 *        -> success state with an "Open in Paseo" deep link
 *
 * Product decision, enforced here: the picker is ALWAYS shown and a send always
 * requires an explicit action. Nothing is ever created silently.
 */

import type {
  Candidate,
  Mode,
  PrRef,
  Provider,
  ResolveResponse,
  SendResponse,
  SendTarget,
} from "../shared/contract";
import { providerIdOf } from "../shared/contract";
import { presentError } from "../shared/errors";
import type { FailurePayload } from "../shared/messages";
import { sendIntent } from "./bridge";
import { Combobox } from "./ui/combobox";
import { clear, cogIcon, el, renderProse } from "./ui/dom";
import { containKeyboard } from "./ui/keyboard";
import { POPOVER_CSS } from "./ui/styles";

const HOST_TAG = "send-to-paseo-popover";

export interface PopoverContext {
  pr: PrRef;
  stackPrNumbers: number[];
  pageUrl: string;
  anchor: HTMLElement;
}

let current: Popover | null = null;

export function isPopoverOpen(): boolean {
  return current !== null;
}

export function closePopover(): void {
  current?.destroy();
  current = null;
}

export function togglePopover(ctx: PopoverContext): void {
  if (current) {
    const same = current.samePr(ctx.pr);
    closePopover();
    if (same) return;
  }
  current = new Popover(ctx);
  current.open();
}

type Phase = "loading" | "ready" | "sending" | "sent" | "error";

class Popover {
  private readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly card: HTMLElement;
  private readonly ctx: PopoverContext;

  private phase: Phase = "loading";
  private resolved: ResolveResponse | null = null;
  private failure: FailurePayload | null = null;
  private sendResult: SendResponse | null = null;

  private draft = "";
  private candidateIndex = 0;
  private providerId = "";
  private modeId = "";
  private defaultProviderPref = "";

  private textarea: HTMLTextAreaElement | null = null;
  /** The Target combobox of the *current* render, or null outside "ready". */
  private candidateCombo: Combobox | null = null;
  private disposers: (() => void)[] = [];

  constructor(ctx: PopoverContext) {
    this.ctx = ctx;
    this.host = document.createElement(HOST_TAG);
    this.host.setAttribute("data-send-to-paseo", "popover");
    this.host.setAttribute("data-stp-pr", String(ctx.pr.number));
    this.root = this.host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = POPOVER_CSS;
    this.root.append(style);
    this.card = el("div", { class: "card", role: "dialog", "aria-label": "Send to Paseo" });
    this.root.append(this.card);
    // Before anything can be typed: keep our keystrokes out of Graphite's
    // shortcut handlers. See ui/keyboard.ts for why this is not optional.
    this.disposers.push(containKeyboard(this.host));
  }

  samePr(pr: PrRef): boolean {
    const a = this.ctx.pr;
    return a.owner === pr.owner && a.repo === pr.repo && a.number === pr.number;
  }

  open(): void {
    document.body.append(this.host);
    this.ctx.anchor.setAttribute("aria-expanded", "true");
    this.render();
    this.position();

    // Dismissal LAYERS, and both layers are decided here rather than inside the
    // widget. The Target dropdown is an inner overlay: a click or an Escape has
    // to close it alone and leave the card up, and only reach the card once the
    // dropdown is already closed.
    const onDocPointer = (e: Event) => {
      const path = e.composedPath();
      if (path.includes(this.host) || path.includes(this.ctx.anchor)) {
        // Inside our own surface, so the card survives — but a pointerdown
        // anywhere in the card that is NOT in the dropdown (the textarea, the
        // Provider select, the header) dismisses the dropdown, which is what
        // every other menu on both sites does.
        if (this.candidateCombo && !this.candidateCombo.containsPath(path)) {
          this.candidateCombo.close();
        }
        return;
      }
      closePopover();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      // This listener is document-level and CAPTURING, so it runs before the
      // event has descended into the shadow tree — a keydown handler on the
      // search input could never see Escape first. Hence the inner layer is
      // asked here, in order: dropdown, then card.
      if (this.candidateCombo?.handleEscape()) return;
      closePopover();
    };
    const onReflow = () => this.position();

    document.addEventListener("pointerdown", onDocPointer, true);
    // Esc is captured on the document so it works whether focus is inside the
    // shadow root or Graphite stole it back.
    document.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    this.disposers.push(
      () => document.removeEventListener("pointerdown", onDocPointer, true),
      () => document.removeEventListener("keydown", onKey, true),
      () => window.removeEventListener("resize", onReflow),
      () => window.removeEventListener("scroll", onReflow, true),
    );

    void this.loadResolve();
  }

  destroy(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
    this.ctx.anchor.setAttribute("aria-expanded", "false");
    this.host.remove();
  }

  /* ---------------------------------------------------------------------- */
  /* data                                                                    */
  /* ---------------------------------------------------------------------- */

  private async loadResolve(): Promise<void> {
    this.phase = "loading";
    this.failure = null;
    this.render();

    // Public settings only — the token stays in the service worker.
    const settings = await sendIntent({ type: "getPublicSettings" });
    if (settings.ok) this.defaultProviderPref = settings.data.defaultProvider;

    const res = await sendIntent({
      type: "resolve",
      pr: this.ctx.pr,
      stackPrNumbers: this.ctx.stackPrNumbers,
    });

    if (!this.host.isConnected) return; // closed while in flight

    if (!res.ok) {
      this.failure = res.error;
      this.phase = "error";
      this.render();
      return;
    }

    this.resolved = res.data;
    this.candidateIndex = clampIndex(res.data.defaultCandidateIndex, res.data.candidates.length);
    this.providerId = pickProvider(res.data.providers, this.defaultProviderPref);
    this.modeId = pickMode(res.data.modes ?? [], this.providerId, res.data.resolvedModeId ?? "");
    this.phase = "ready";
    this.render();
    this.position();
    this.textarea?.focus();
  }

  private async doSend(): Promise<void> {
    if (this.phase === "sending") return;
    const resolved = this.resolved;
    if (!resolved) return;
    const prompt = (this.textarea?.value ?? this.draft).trim();
    if (!prompt) {
      this.textarea?.focus();
      return;
    }
    this.draft = prompt;

    const candidate = resolved.candidates[this.candidateIndex];
    const target: SendTarget =
      candidate?.kind === "existing" && candidate.workspaceId
        ? { kind: "existing", workspaceId: candidate.workspaceId }
        : { kind: "create" };

    this.phase = "sending";
    this.failure = null;
    this.render();

    const res = await sendIntent({
      type: "send",
      pr: this.ctx.pr,
      prompt,
      target,
      provider: this.providerId || undefined,
      modeId: this.modeId || undefined,
      pageUrl: this.ctx.pageUrl,
    });

    if (!this.host.isConnected) return;

    if (!res.ok) {
      this.failure = res.error;
      this.phase = "error";
      this.render();
      return;
    }
    this.sendResult = res.data;
    this.phase = "sent";
    this.render();
    this.position();
  }

  /* ---------------------------------------------------------------------- */
  /* render                                                                  */
  /* ---------------------------------------------------------------------- */

  private render(): void {
    clear(this.card);
    this.textarea = null;
    // A render throws the whole card away, so the previous combobox instance
    // (and with it any half-typed query and its open state) goes with it. That
    // is the one behaviour that keeps a commit from leaving a stale dropdown
    // floating over a card that has been rebuilt underneath it.
    this.candidateCombo = null;
    this.host.setAttribute("data-stp-phase", this.phase);
    if (this.phase === "sent") {
      this.host.setAttribute("data-stp-dryrun", String(this.sendResult?.dryRun === true));
    } else {
      this.host.removeAttribute("data-stp-dryrun");
    }

    this.card.append(this.renderHeader());

    switch (this.phase) {
      case "loading":
        this.card.append(
          el("div", { class: "body" }, [
            el("div", { class: "status", "data-stp-loading": "1" }, [
              el("span", { class: "spinner" }),
              "Resolving workspace for this PR…",
            ]),
          ]),
        );
        break;

      case "error":
        this.card.append(el("div", { class: "body" }, [this.renderError()]));
        this.card.append(this.renderErrorFooter());
        break;

      case "sent":
        this.card.append(el("div", { class: "body" }, [this.renderSuccess()]));
        break;

      case "ready":
      case "sending":
        this.card.append(this.renderForm());
        this.card.append(this.renderFormFooter());
        break;
    }
  }

  private renderHeader(): HTMLElement {
    const { owner, repo, number } = this.ctx.pr;
    // The PR reference and the cog share a group so the header's
    // `space-between` still puts the title hard left and both of these hard
    // right; three bare children would strand the reference in the middle.
    return el("header", {}, [
      el("span", { class: "title" }, ["Send to Paseo"]),
      el("span", { class: "head-right" }, [
        el("span", { class: "pr", "data-stp-prref": "" }, [`${owner}/${repo} #${number}`]),
        this.settingsButton(),
      ]),
    ]);
  }

  /**
   * Opens the extension's options page.
   *
   * Rendered in *every* phase, deliberately. The error path already offers an
   * options link, but the two things a user most often needs to fix — a token
   * that was never pasted and a bridge URL that is wrong — are reachable from
   * the options page and from nowhere else, and until now the only way there
   * from a PR page was the browser's own extensions menu.
   *
   * It does NOT close the popover. `openOptionsPage()` opens a new tab, so this
   * one is merely backgrounded; closing would also discard a typed
   * instruction, and losing a draft is worse than pressing Esc once.
   */
  private settingsButton(): HTMLElement {
    const btn = el("button", {
      class: "cog",
      type: "button",
      "data-stp-open-settings": "",
      "aria-label": "Extension settings",
      title: "Extension settings",
    }) as HTMLButtonElement;
    // An SVG node, not a glyph: no font on any host page is guaranteed to carry
    // a gear, and an emoji one is a different size on every OS. It strokes in
    // `currentColor`, so it inherits the header's muted foreground and flips
    // with the theme without a second rule.
    btn.append(cogIcon());
    // No `stopPropagation`: the popover's own outside-click handler already
    // ignores anything whose composed path contains the host, and the card is
    // not a child of the anchor, so nothing here can re-reach the toggle. The
    // error state's options link has never needed it either. Verified by
    // removing the guard and re-running the suite green.
    btn.addEventListener("click", () => void sendIntent({ type: "openOptions" }));
    return btn;
  }

  private renderForm(): HTMLElement {
    const resolved = this.resolved!;
    const body = el("div", { class: "body" });

    // Built first so the textarea's input handler can enable/disable it. It is
    // appended by renderFormFooter().
    const sendBtn = this.sendButton();
    this.pendingSendBtn = sendBtn;

    body.append(this.renderTargetSummary(resolved));

    /* Candidate picker — ALWAYS rendered, even when rank 1 matched.
       A searchable, non-native combobox rather than a <select>: a workspace list
       is long, and the thing the user knows is usually the workspace *name*.
       `data-stp-candidates` stays on the trigger, whose textContent is exactly
       the committed option's label. */
    const combo = new Combobox({
      options: resolved.candidates.map((c) => ({
        label: candidateOptionLabel(c),
        search: candidateSearchText(c),
      })),
      selected: this.candidateIndex,
      label: "Target workspace",
      searchPlaceholder: "Search workspace, branch or #PR…",
      emptyText: "No workspace matches",
      triggerAttrs: { "data-stp-candidates": "" },
      onCommit: (i) => {
        this.candidateIndex = clampIndex(i, resolved.candidates.length);
        this.draft = this.textarea?.value ?? this.draft;
        this.render();
        // The card's height changes with the selection (the sibling-branch note
        // comes and goes), so re-anchor before moving on.
        this.position();
        // Target chosen, so the next thing wanted is the instruction — which is
        // also what makes ⌘/Ctrl+Enter work straight after a keyboard commit.
        this.textarea?.focus();
      },
      // Opening the panel grows the card in normal flow; position() measures
      // that height, so it has to run again on every open and close.
      onResize: () => this.position(),
    });
    this.candidateCombo = combo;
    body.append(
      el("div", { class: "field" }, [
        el("span", { class: "lbl" }, [`Target (${resolved.candidates.length} candidates)`]),
        combo.root,
      ]),
    );

    /* Instruction */
    const ta = el("textarea", {
      placeholder: "Fix merge conflicts",
      "data-stp-prompt": "",
      "aria-label": "Instruction for the agent",
      rows: "4",
    }) as HTMLTextAreaElement;
    ta.value = this.draft;
    ta.addEventListener("input", () => {
      this.draft = ta.value;
      sendBtn.toggleAttribute("disabled", ta.value.trim().length === 0);
    });
    ta.addEventListener("keydown", (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        void this.doSend();
      }
    });
    this.textarea = ta;
    body.append(
      el("label", { class: "field" }, [el("span", { class: "lbl" }, ["Instruction"]), ta]),
    );

    /* Provider */
    if (resolved.providers.length) {
      const providerSelect = el("select", {
        "data-stp-provider": "",
        "aria-label": "Provider",
      }) as HTMLSelectElement;
      for (const p of resolved.providers) {
        providerSelect.append(
          el("option", { value: p.id }, [p.isDefault ? `${p.label} (default)` : p.label]),
        );
      }
      providerSelect.value = this.providerId;
      providerSelect.addEventListener("change", () => {
        this.providerId = providerSelect.value;
        // Mode ids belong to a provider, so the Mode select's contents change
        // with this one. Re-render (keeping the draft, exactly as the candidate
        // select does) and re-pick the mode for the new provider.
        this.modeId = pickMode(resolved.modes ?? [], this.providerId, "");
        this.draft = this.textarea?.value ?? this.draft;
        this.render();
        this.textarea?.focus();
      });
      body.append(
        el("label", { class: "field" }, [
          el("span", { class: "lbl" }, ["Provider"]),
          providerSelect,
        ]),
      );
    }

    /* Mode — filtered to the selected provider, because mode ids are per-provider. */
    const providerModes = modesFor(resolved.modes ?? [], this.providerId);
    if (providerModes.length) {
      const modeSelect = el("select", {
        "data-stp-mode": "",
        "aria-label": "Permission mode",
      }) as HTMLSelectElement;
      for (const m of providerModes) {
        // Unattended modes are listed, never hidden — the danger is surfaced
        // instead: a marker glyph that survives any platform that ignores
        // option colours, plus the warning colour where it does not.
        const unattended = m.isUnattended === true || m.colorTier === "dangerous";
        const label = `${unattended ? "⚠ " : ""}${m.label}${m.isDefault ? " (default)" : ""}`;
        const opt = el("option", {
          value: m.id,
          ...(unattended ? { class: "danger", "data-stp-mode-danger": "true" } : {}),
        }, [label]);
        modeSelect.append(opt);
      }
      modeSelect.value = this.modeId;
      modeSelect.addEventListener("change", () => {
        this.modeId = modeSelect.value;
        this.draft = this.textarea?.value ?? this.draft;
        this.render();
        this.textarea?.focus();
      });
      const field = el("label", { class: "field" }, [
        el("span", { class: "lbl" }, ["Mode"]),
        modeSelect,
      ]);
      const selected = providerModes.find((m) => m.id === this.modeId);
      if (selected && (selected.isUnattended === true || selected.colorTier === "dangerous")) {
        field.append(
          el("span", { class: "mode-warning", "data-stp-mode-warning": "" }, [
            `${selected.label}: the agent will not ask for permission before acting.`,
          ]),
        );
      }
      body.append(field);
    }

    return body;
  }

  private pendingSendBtn: HTMLButtonElement | null = null;

  private sendButton(): HTMLButtonElement {
    const sending = this.phase === "sending";
    const btn = el("button", {
      class: "btn primary",
      "data-stp-send": "",
      type: "button",
    }) as HTMLButtonElement;
    if (sending) {
      btn.append(el("span", { class: "spinner" }), document.createTextNode("Sending…"));
      btn.disabled = true;
    } else {
      btn.textContent = "Send";
      btn.disabled = this.draft.trim().length === 0;
      btn.addEventListener("click", () => void this.doSend());
    }
    return btn;
  }

  private renderFormFooter(): HTMLElement {
    const btn = this.pendingSendBtn ?? this.sendButton();
    this.pendingSendBtn = null;
    const hint = el("span", { class: "kbd-hint" }, []);
    // `sym` marks symbol-only keycaps so they can be optically size-matched to
    // the lettered ones (see kbd.sym in styles.ts).
    const mac = isMac();
    hint.append(
      el("kbd", mac ? { class: "sym" } : {}, [mac ? "⌘" : "Ctrl"]),
      document.createTextNode(" "),
      el("kbd", { class: "sym" }, ["↵"]),
      document.createTextNode(" to send · "),
      el("kbd", {}, ["Esc"]),
      document.createTextNode(" to close"),
    );
    return el("footer", {}, [hint, btn]);
  }

  private renderTargetSummary(resolved: ResolveResponse): HTMLElement {
    const c = resolved.candidates[this.candidateIndex];
    const box = el("div", { class: "target-summary", "data-stp-target-summary": "" });
    box.append(el("span", { class: "arrow" }, ["→ "]));

    if (!c) {
      box.append(document.createTextNode("no candidate selected"));
      return box;
    }
    if (c.kind === "create") {
      box.append(document.createTextNode(`will create worktree for PR #${resolved.pr.number}`));
    } else {
      box.append(document.createTextNode("workspace "), el("code", {}, [c.label]));
      if (c.reason === "stack" && c.stackPrNumber) {
        box.append(
          document.createTextNode(` · stack #${c.stackPrNumber}${stackStateSuffix(c)}`),
        );
      }
    }
    const sub = el("span", { class: "sub" });
    sub.append(
      document.createTextNode(c.branch ? `${c.branch}` : resolved.pr.headBranch),
      document.createTextNode(` · ${resolved.project.name}`),
    );
    box.append(sub);

    // One workspace per stack is normal, so the resolved target is often a
    // worktree on a *sibling* branch. Say so, rather than letting the branch on
    // the line above be mistaken for this PR's branch.
    //
    // `resolved.pr.headBranch` must be non-empty. When `gh` is unavailable the
    // bridge deliberately never guesses it and sends "", and "any branch !== \"\""
    // is true for every existing candidate — which asserted a mismatch nothing
    // could actually know about. Unknown is not "different".
    if (
      c.kind === "existing" &&
      c.branch &&
      resolved.pr.headBranch &&
      c.branch !== resolved.pr.headBranch
    ) {
      box.append(
        el("span", { class: "mismatch", "data-stp-branch-mismatch": "" }, [
          branchMismatchNote(c),
        ]),
      );
    }
    return box;
  }

  private renderError(): HTMLElement {
    const f = this.failure!;
    const p = presentError(f.code);
    const box = el("div", { class: "error", "data-stp-error": f.code, role: "alert" });
    box.append(el("div", { class: "etitle", "data-stp-error-title": "" }, [p.title]));
    if (f.message) {
      box.append(el("div", { class: "emsg" }, [renderProse(f.message)]));
    }
    box.append(
      el("div", { class: "ehint", "data-stp-error-hint": "" }, [renderProse(f.hint ?? p.hint)]),
    );
    if (p.openOptions) {
      const a = el("a", { class: "link", "data-stp-open-options": "", role: "button", tabindex: "0" }, [
        "Open extension options",
      ]);
      const go = () => void sendIntent({ type: "openOptions" });
      a.addEventListener("click", go);
      a.addEventListener("keydown", (e) => {
        if ((e as KeyboardEvent).key === "Enter") go();
      });
      box.append(a);
    }
    box.append(
      el("div", { class: "ecode" }, [
        f.status ? `${f.code} · HTTP ${f.status}` : f.code,
      ]),
    );
    return box;
  }

  private renderErrorFooter(): HTMLElement {
    const retry = el("button", { class: "btn", "data-stp-retry": "", type: "button" }, [
      "Try again",
    ]) as HTMLButtonElement;
    retry.addEventListener("click", () => {
      if (this.resolved) {
        this.phase = "ready";
        this.failure = null;
        this.render();
        this.textarea?.focus();
      } else {
        void this.loadResolve();
      }
    });
    const close = el("button", { class: "btn", "data-stp-close": "", type: "button" }, [
      "Close",
    ]) as HTMLButtonElement;
    close.addEventListener("click", () => closePopover());
    return el("footer", {}, [close, retry]);
  }

  private renderSuccess(): HTMLElement {
    const r = this.sendResult!;
    // CONTRACT.md: `dryRun` is always present on a 200. It MUST be surfaced
    // distinctly, so a dry-run send can never be mistaken for a real one — a
    // different headline, a badge, and an explicit "nothing was created" line.
    const dry = r.dryRun === true;
    const box = el("div", { class: dry ? "success dry" : "success" });

    const title = el("div", { class: "stitle", "data-stp-success": "" });
    title.append(document.createTextNode(dry ? "Dry run — no agent created" : "Agent started"));
    if (dry) title.append(el("span", { class: "badge", "data-stp-dryrun": "true" }, ["DRY RUN"]));
    box.append(title);

    if (dry) {
      box.append(
        el("div", { class: "dry-note" }, [
          renderProse(
            "The plugin is running with SEND_TO_PASEO_DRY_RUN=1. Resolution and validation ran, but no workspace or agent was created and the ids below are synthetic.",
          ),
        ]),
      );
    }

    const detail = el("div", { class: "sdetail" });
    detail.append(document.createTextNode(r.title));
    if (r.workspaceLabel) {
      detail.append(
        document.createTextNode(r.workspaceCreated ? " · created workspace " : " · workspace "),
        el("code", {}, [r.workspaceLabel]),
      );
    }
    if (r.branch) detail.append(document.createTextNode(" · "), el("code", {}, [r.branch]));
    box.append(detail);

    // `deepLink` is OPAQUE (CONTRACT.md "Deep link format"): rendered verbatim,
    // never constructed or parsed here.
    const link = el(
      "a",
      {
        class: dry ? "deep-link muted" : "deep-link",
        "data-stp-deeplink": r.deepLink,
        href: r.deepLink,
      },
      [dry ? "Open in Paseo (synthetic id)" : "Open in Paseo"],
    );
    box.append(link);
    box.append(el("div", { class: "deep-link-raw" }, [r.deepLink]));

    const footerish = el("div", { class: "status" });
    const again = el("button", { class: "btn", "data-stp-send-another": "", type: "button" }, [
      "Send another",
    ]) as HTMLButtonElement;
    again.addEventListener("click", () => {
      this.draft = "";
      this.sendResult = null;
      this.phase = "ready";
      this.render();
      this.textarea?.focus();
    });
    footerish.append(again);
    box.append(footerish);
    return box;
  }

  /* ---------------------------------------------------------------------- */
  /* positioning                                                             */
  /* ---------------------------------------------------------------------- */

  private position(): void {
    const r = this.ctx.anchor.getBoundingClientRect();
    const cardRect = this.card.getBoundingClientRect();
    const w = cardRect.width || 392;
    const h = cardRect.height || 260;
    const margin = 8;

    let left = r.right - w;
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - w - margin));

    let top = r.bottom + 6;
    if (top + h > window.innerHeight - margin) {
      const above = r.top - h - 6;
      top = above >= margin ? above : Math.max(margin, window.innerHeight - h - margin);
    }

    this.host.style.left = `${Math.round(left)}px`;
    this.host.style.top = `${Math.round(top)}px`;
  }
}

/* -------------------------------------------------------------------------- */

/** The human-readable reason tag shown in parentheses on an existing candidate. */
function candidateReasonTag(c: Candidate): string {
  return c.reason === "exact"
    ? "exact match"
    : c.reason === "stack"
      ? `stack${c.stackPrNumber ? ` #${c.stackPrNumber}` : ""}${stackStateSuffix(c)}`
      : c.reason === "project"
        ? "same project"
        : String(c.reason);
}

/**
 * `, merged` / `, closed` for a stack candidate whose PR is no longer open.
 *
 * Additive field, so a plugin that predates merged-stack detection sends
 * nothing — and nothing is exactly what `open` means on the wire, which is why
 * absent and `"open"` are treated identically here rather than as "unknown".
 *
 * It goes through the reason tag rather than being appended separately so that
 * one change reaches the option label, the trigger and the search haystack at
 * once: a user who knows the workspace they want is parked on a merged branch
 * can type "merged" and find it.
 */
function stackStateSuffix(c: Candidate): string {
  const state = c.stackPrState;
  if (state === undefined || state === "open") return "";
  return `, ${state}`;
}

function candidateOptionLabel(c: Candidate): string {
  if (c.kind === "create") return `${c.label}${c.branch ? ` — ${c.branch}` : ""}`;
  const bits = [c.label];
  if (c.branch) bits.push(c.branch);
  let out = `${bits.join(" — ")} (${candidateReasonTag(c)}`;
  if (typeof c.agentCount === "number") out += `, ${c.agentCount} agent${c.agentCount === 1 ? "" : "s"}`;
  return `${out})`;
}

/**
 * Everything the Target search matches against.
 *
 * Built separately from the option label, not scraped from it, because some of
 * it is not in the label: a stack PR number is written `#941` there but people
 * type it bare, and the create row is what you want when you type "create" or
 * "new" even though it says "Create worktree for PR #942". Workspace label
 * first — that is the field users actually remember.
 */
/**
 * What to say about a target whose branch is not this PR's branch.
 *
 * Reason-aware, because a single sentence cannot be true of every case. It read
 * "another branch of this stack" for *every* existing candidate, which is a
 * false claim about a rank-3 "same project" workspace — that branch is not in
 * the stack at all, and saying it is invites the user to trust a target the
 * bridge deliberately refuses to default to. A merged branch gets its own
 * wording for the opposite reason: "another branch of this stack" reads as a
 * live sibling, and a worktree parked on a branch that has already landed is
 * the case this whole ranking path exists to recognise.
 */
function branchMismatchNote(c: Candidate): string {
  if (c.reason !== "stack") return "worktree is on a different branch";
  const state = c.stackPrState;
  if (state === "merged" || state === "closed") {
    return `worktree is on a branch of this stack whose PR is ${state}`;
  }
  return "worktree is on another branch of this stack";
}

function candidateSearchText(c: Candidate): string {
  const bits = [c.label];
  if (c.branch) bits.push(c.branch);
  if (c.kind === "create") bits.push("create", "new worktree");
  else bits.push(candidateReasonTag(c));
  // Both spellings, so "941" and "#941" behave the same.
  if (typeof c.stackPrNumber === "number") bits.push(`#${c.stackPrNumber}`, String(c.stackPrNumber));
  return bits.join(" ");
}

function pickProvider(providers: Provider[], preferred: string): string {
  if (preferred && providers.some((p) => p.id === preferred)) return preferred;
  return providers.find((p) => p.isDefault)?.id ?? providers[0]?.id ?? "";
}

/** Modes belonging to the bare provider inside a `provider/model` pair. */
function modesFor(modes: Mode[], providerModel: string): Mode[] {
  if (!providerModel) return [];
  const provider = providerIdOf(providerModel);
  return modes.filter((m) => m.provider === provider);
}

/**
 * The mode to preselect: the bridge's own resolved mode when it belongs to this
 * provider, else this provider's advertised default, else its first mode. `""`
 * when the provider advertises none, which leaves `modeId` off the send body so
 * the bridge applies its own chain.
 */
function pickMode(modes: Mode[], providerModel: string, resolved: string): string {
  const forProvider = modesFor(modes, providerModel);
  if (resolved && forProvider.some((m) => m.id === resolved)) return resolved;
  return forProvider.find((m) => m.isDefault)?.id ?? forProvider[0]?.id ?? "";
}

function clampIndex(i: number, len: number): number {
  if (!Number.isFinite(i) || i < 0 || i >= len) return 0;
  return Math.trunc(i);
}

function isMac(): boolean {
  return /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}
