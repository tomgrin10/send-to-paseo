/** Tiny DOM helpers. No innerHTML with dynamic data, anywhere. */

export { renderProse } from "../../shared/format";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  for (const c of children) node.append(typeof c === "string" ? document.createTextNode(c) : c);
  return node;
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/**
 * The gear on the popover header's settings button.
 *
 * This is Lucide's `settings` outline, which is the icon family Paseo's own UI
 * draws from (plugin contributions name Lucide icons directly), so the cog
 * reads as native rather than as a second design language. Its 24-unit viewBox
 * is kept and scaled down instead of being redrawn at 16: a hand-rolled gear
 * with straight spokes was tried first and rendered as a sunburst at this size.
 *
 * Built node by node like `sendIcon()` rather than assigned as markup. Two
 * reasons: this module's own rule against `innerHTML`, and the fact that a
 * content script shares its document with the host page — github.com enforces
 * Trusted Types, and an `innerHTML` sink there is exactly the kind of thing the
 * fixture-based suite could never catch, because a fixture enforces nothing.
 */
export function cogIcon(): SVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "15");
  svg.setAttribute("height", "15");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const body = document.createElementNS(NS, "path");
  body.setAttribute(
    "d",
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 " +
      "0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 " +
      "2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 " +
      "1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 " +
      "2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 " +
      "1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 " +
      "1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z",
  );
  const hub = document.createElementNS(NS, "circle");
  hub.setAttribute("cx", "12");
  hub.setAttribute("cy", "12");
  hub.setAttribute("r", "3");
  for (const node of [body, hub]) {
    node.setAttribute("stroke", "currentColor");
    node.setAttribute("stroke-width", "2");
    node.setAttribute("stroke-linecap", "round");
    node.setAttribute("stroke-linejoin", "round");
    svg.append(node);
  }
  return svg as unknown as SVGElement;
}

/** The Paseo send glyph used on the button. */
export function sendIcon(): SVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(NS, "path");
  path.setAttribute("d", "M1.8 7.2 13.4 2.1a.55.55 0 0 1 .74.72L9.3 14.2a.55.55 0 0 1-1.02-.05L6.7 9.7 2.0 8.2a.55.55 0 0 1-.2-1Z");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.3");
  path.setAttribute("stroke-linejoin", "round");
  svg.append(path);
  return svg as unknown as SVGElement;
}

/** Shared builder for the 24-unit Lucide-style outline icons below. */
function lucide(paths: string[], size = 16, strokeWidth = "2"): SVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths) {
    const path = document.createElementNS(NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", strokeWidth);
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg as unknown as SVGElement;
}

/** Lucide `check`: the button's "Sent" state and the success headline. */
export function checkIcon(size = 16): SVGElement {
  return lucide(["M20 6 9 17l-5-5"], size, "2.2");
}

/** Lucide `loader-circle`: an open arc that the stylesheet rotates. */
export function spinnerIcon(size = 16): SVGElement {
  const svg = lucide(["M21 12a9 9 0 1 1-6.219-8.56"], size, "2.2");
  svg.setAttribute("class", "spin");
  return svg;
}

/** Lucide `external-link`, for the "Open in Paseo" deep link. */
export function externalIcon(size = 14): SVGElement {
  return lucide(["M15 3h6v6", "M10 14 21 3", "M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"], size, "2");
}

const FOLDER = "M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z";

/** Lucide `folder`: leads the popover's target line for an existing workspace. */
export function folderIcon(size = 14): SVGElement {
  return lucide([FOLDER], size, "2");
}

/** Lucide `folder-plus`: the target line when the send will create a worktree. */
export function folderPlusIcon(size = 14): SVGElement {
  return lucide([FOLDER, "M12 10v6", "M9 13h6"], size, "2");
}

/** Lucide `git-branch` (circles drawn as arcs): leads the route-reason line. */
export function branchIcon(size = 12): SVGElement {
  return lucide(
    ["M6 3v12", "M21 6a3 3 0 1 1-6 0a3 3 0 1 1 6 0", "M9 18a3 3 0 1 1-6 0a3 3 0 1 1 6 0", "M18 9a9 9 0 0 1-9 9"],
    size,
    "2",
  );
}

/** Lucide `copy`, for the error card's "Copy details". */
export function copyIcon(size = 12): SVGElement {
  return lucide(["M10 8h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V10a2 2 0 0 1 2-2Z", "M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"], size, "2");
}
