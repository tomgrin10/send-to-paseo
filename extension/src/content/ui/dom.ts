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
 * Built node by node like `paseoMark()` rather than assigned as markup. Two
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

/**
 * Paseo's own mark on the page button, so the button reads as Paseo's. Same
 * path as Paseo's `PaseoLogo` (packages/app/src/components/icons/paseo-logo.tsx,
 * Apache-2.0), filled with `currentColor` like the button's other glyphs. The
 * viewBox is cropped from the source's 700-unit square to the mark's own
 * bounds (x 105-628, y 83-622), so it fills the icon slot the way the old
 * paper plane did instead of floating small inside empty margin.
 */
export function paseoMark(): SVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "96 82 540 540");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(NS, "path");
  path.setAttribute(
    "d",
    "M291.495 91.399C333.897 104.892 379.155 135.075 416.229 173.191C453.389 211.394 484.429 259.725 495.708 311.25" +
      "1C497.555 319.693 498.865 328.216 499.586 336.776C509.755 326.554 519.867 317.815 529.89 311.547C540.647 304.8" +
      "21 553.808 299.297 568.641 299.785C584.29 300.299 597.395 307.326 607.747 317.632C632.173 341.947 629.612 372." +
      "898 619.872 397.936C610.185 422.833 591.557 447.826 572.732 469.124C553.591 490.78 532.713 510.308 516.779 524" +
      ".318C508.775 531.355 501.936 537.073 497.07 541.052C494.635 543.043 492.689 544.603 491.334 545.679C490.657 54" +
      "6.217 490.126 546.635 489.756 546.926C489.571 547.071 489.425 547.184 489.321 547.265C489.269 547.305 489.227 " +
      "547.338 489.196 547.362C489.181 547.374 489.168 547.385 489.157 547.393C489.153 547.397 489.147 547.401 489.14" +
      "4 547.403C489.134 547.4 488.837 547.06 473.001 528.499L489.135 547.411C478.157 555.911 462.033 554.334 453.122" +
      " 543.89C444.213 533.448 445.887 518.094 456.861 509.592C456.863 509.591 456.865 509.588 456.869 509.586C456.88" +
      " 509.577 456.902 509.561 456.933 509.536C456.997 509.487 457.101 509.404 457.245 509.292C457.533 509.066 457.9" +
      "79 508.715 458.569 508.247C459.749 507.31 461.506 505.901 463.742 504.073C468.216 500.414 474.589 495.088 482." +
      "073 488.508C497.114 475.284 516.315 457.282 533.578 437.75C551.157 417.862 565.26 398.01 571.859 381.048C578.4" +
      "03 364.227 575.681 356.302 570.724 351.367C568.928 349.579 567.744 348.902 567.267 348.676C566.888 348.496 566" +
      ".811 348.52 566.804 348.52C566.605 348.513 563.971 348.537 557.953 352.3C545.161 360.299 528.815 377.492 506.8" +
      "07 403.867C494.927 418.106 481.871 434.435 467.547 451.957C463.709 457.28 459.503 462.538 454.91 467.717L454.7" +
      "02 467.549C420.808 508.347 380.37 553.856 332.335 593.848C301.853 619.226 262.656 622.597 228.642 614.743C194." +
      "834 606.936 162.658 587.448 142.217 561.686C108.054 518.631 100.57 469.801 108.223 427.836C115.56 387.606 137." +
      "391 351.005 166.502 331.557C161.248 315.813 156.813 299.49 153.519 283.013C142.593 228.368 143.239 167.031 174" +
      ".28 119.619C186.922 100.31 205.846 89.1535 227.387 85.2773C248.1 81.5504 270.278 84.648 291.495 91.399ZM378.64" +
      "2 206.356C345.773 172.563 307.463 147.917 275.208 137.654C259.096 132.527 246.171 131.514 236.828 133.195C228." +
      "314 134.727 222.227 138.497 217.721 145.38C196.712 177.468 193.858 224.004 203.82 273.827C206.532 287.394 210." +
      "127 300.834 214.345 313.817C236.45 310.276 260.156 311.463 281.22 317.11C319.621 327.403 357.501 355.419 357.5" +
      "01 405.654C357.501 435.255 339.111 465.136 307.278 473.815C273.211 483.103 238.854 464.822 213.105 427.541C203" +
      ".716 413.947 194.443 397.766 185.947 379.89C174.028 392.223 163.08 411.953 158.673 436.118C153.128 466.518 158" +
      ".514 501.286 183.085 532.253C195.993 548.522 217.742 562.031 240.771 567.349C263.594 572.619 284.147 569.24 29" +
      "8.664 557.154C349.383 514.927 390.709 466.547 426.366 422.952C448.879 390.86 453.195 356.06 445.578 321.265C43" +
      "6.703 280.718 411.425 240.06 378.642 206.356ZM306.296 405.722C306.296 384.769 292.223 370.736 267.284 364.051C" +
      "256.012 361.03 244.156 360.087 233.095 360.771C240.361 375.935 248.168 389.513 255.897 400.704C275.647 429.298" +
      " 289.989 427.822 293.247 426.934C298.737 425.437 306.296 418.161 306.296 405.722Z",
  );
  path.setAttribute("fill", "currentColor");
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

/**
 * Follow-up's app icon, drawn small beside "Workspace for this PR" so the
 * section reads as Follow-up's data rather than Send to Paseo's own. It is the
 * same artwork as paseo-follow-up's `assets/icon.svg` (256-unit tile, the
 * trail stroke, its start ring and the lilac end dot), built node by node for
 * the same Trusted Types reason as `cogIcon()`. Vector, so it stays crisp at 2x.
 * Decorative: the wrapper in the popover carries the accessible name.
 */
export function followUpMark(size = 14): SVGElement {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 256 256");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const tile = document.createElementNS(NS, "rect");
  tile.setAttribute("width", "256");
  tile.setAttribute("height", "256");
  tile.setAttribute("rx", "52");
  tile.setAttribute("fill", "#222126");
  const g = document.createElementNS(NS, "g");
  g.setAttribute("transform", "translate(24.8 24.8) scale(8.6)");
  const trail = document.createElementNS(NS, "path");
  trail.setAttribute(
    "d",
    "M6.95 19.21C7.25 19.11 8.19 18.91 8.75 18.59C9.3 18.27 9.7 18 10.29 17.29C10.89 16.58 11.8 15.23 12.34 " +
      "14.32C12.87 13.41 13.14 12.75 13.51 11.84C13.88 10.93 14.29 9.96 14.57 8.87C14.84 7.78 15.17 6.23 15.18 " +
      "5.28C15.2 4.33 14.88 3.61 14.63 3.18C14.38 2.74 14.04 2.66 13.7 2.68C13.36 2.7 12.92 2.85 12.58 3.3C12.25 " +
      "3.75 11.93 4.48 11.72 5.4C11.5 6.33 11.32 7.8 11.29 8.87C11.25 9.94 11.36 10.93 11.53 11.84C11.71 12.75 " +
      "11.97 13.58 12.34 14.32C12.71 15.06 13.23 15.8 13.76 16.3C14.29 16.79 14.98 17.03 15.49 17.29C16.01 17.55 " +
      "16.63 17.75 16.86 17.85",
  );
  trail.setAttribute("fill", "none");
  trail.setAttribute("stroke-linecap", "round");
  trail.setAttribute("stroke-linejoin", "round");
  const ring = document.createElementNS(NS, "circle");
  ring.setAttribute("cx", "4.85");
  ring.setAttribute("cy", "19.15");
  ring.setAttribute("r", "2.14");
  ring.setAttribute("fill", "none");
  for (const node of [trail, ring]) {
    node.setAttribute("stroke", "#ffffff");
    node.setAttribute("stroke-width", "1.42");
  }
  const dot = document.createElementNS(NS, "circle");
  dot.setAttribute("cx", "20.01");
  dot.setAttribute("cy", "18.03");
  dot.setAttribute("r", "1.92");
  dot.setAttribute("fill", "#B79CF0");
  g.append(trail, ring, dot);
  svg.append(tile, g);
  return svg as unknown as SVGElement;
}
