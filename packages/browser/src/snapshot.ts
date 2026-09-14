/** An interactive element on the page, numbered for the model (Browser Use style). */
export interface SnapshotElement {
  index: number;
  tag: string;
  role: string | null;
  type: string | null;
  label: string;
  href: string | null;
  value: string | null;
  checked: boolean | null;
  disabled: boolean;
  inViewport: boolean;
}

export interface PageSnapshot {
  url: string;
  title: string;
  elements: SnapshotElement[];
  text: string;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
  truncatedElements: boolean;
}

export const ELEMENT_ATTRIBUTE = "data-aiw-index";

/**
 * Runs in the page: numbers visible interactive elements with a data attribute
 * so actions can target them by index, and describes each one briefly. Kept as
 * plain JS source: bundlers add helpers (e.g. __name) to functions, which do
 * not exist inside the page.
 */
export const COLLECT_ELEMENTS_SCRIPT = String.raw`(args) => {
  const { attribute, max } = args;
  for (const el of Array.from(document.querySelectorAll("[" + attribute + "]"))) el.removeAttribute(attribute);
  const selector = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea", "summary",
    "[role=button]", "[role=link]", "[role=checkbox]", "[role=radio]", "[role=tab]", "[role=menuitem]",
    "[role=option]", "[role=switch]", "[role=combobox]", "[role=textbox]", "[role=searchbox]",
    "[contenteditable=\"\"]", "[contenteditable=true]", "[onclick]",
  ].join(",");
  const clean = (value, length = 100) => (value == null ? "" : String(value)).replace(/\s+/g, " ").trim().slice(0, length);
  const elements = [];
  let truncated = false;
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    if (rect.width < 1 || rect.height < 1 || style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) continue;
    if (elements.length >= max) { truncated = true; break; }
    const index = elements.length + 1;
    el.setAttribute(attribute, String(index));
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute("type");
    const labels = el.labels ? Array.from(el.labels).map((l) => l.innerText).join(" ") : "";
    const label = clean(
      el.getAttribute("aria-label") || labels || el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("alt") ||
      (tag === "select" && el.selectedOptions[0] ? el.selectedOptions[0].text : "") || el.innerText ||
      (tag === "input" && (type === "submit" || type === "button") ? el.value : ""),
    );
    const isField = tag === "input" || tag === "textarea";
    elements.push({
      index, tag, role: el.getAttribute("role"), type, label,
      href: tag === "a" ? clean(el.href, 200) : null,
      value: isField && type !== "password" ? clean(el.value, 100) : isField ? (el.value ? "••••" : "") : null,
      checked: type === "checkbox" || type === "radio" ? el.checked : null,
      disabled: Boolean(el.disabled) || el.getAttribute("aria-disabled") === "true",
      inViewport: rect.bottom > 0 && rect.top < window.innerHeight,
    });
  }
  return { elements, truncated, scrollY: Math.round(window.scrollY), scrollHeight: Math.round(document.documentElement.scrollHeight), viewportHeight: window.innerHeight };
}`;

export interface CollectedElements {
  elements: SnapshotElement[];
  truncated: boolean;
  scrollY: number;
  scrollHeight: number;
  viewportHeight: number;
}

export function describeElement(element: SnapshotElement): string {
  const kind = element.role ?? (element.type && element.tag === "input" ? `input[type=${element.type}]` : element.tag);
  const parts = [`[${element.index}] ${kind}`];
  if (element.label) parts.push(`"${element.label}"`);
  if (element.value !== null) parts.push(`value="${element.value}"`);
  if (element.checked !== null) parts.push(element.checked ? "checked" : "unchecked");
  if (element.disabled) parts.push("disabled");
  if (element.href) parts.push(`→ ${element.href}`);
  if (!element.inViewport) parts.push("(off-screen)");
  return parts.join(" ");
}

/** Text the model receives after every browser action. */
export function formatSnapshot(snapshot: PageSnapshot, maxTextChars = 6000): string {
  const text = snapshot.text.length > maxTextChars ? `${snapshot.text.slice(0, maxTextChars)}\n… (page text truncated)` : snapshot.text;
  return [
    `URL: ${snapshot.url}`,
    `Title: ${snapshot.title || "(none)"}`,
    `Scroll: ${snapshot.scrollY} of ${Math.max(0, snapshot.scrollHeight - snapshot.viewportHeight)} px`,
    "",
    "Interactive elements (use the number with browser.click, browser.type or browser.select):",
    ...(snapshot.elements.length ? snapshot.elements.map(describeElement) : ["(none found)"]),
    ...(snapshot.truncatedElements ? ["… more elements not listed; scroll or be more specific."] : []),
    "",
    "Page text:",
    text || "(no readable text)",
  ].join("\n");
}
