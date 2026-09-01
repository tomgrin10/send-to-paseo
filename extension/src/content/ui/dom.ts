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
