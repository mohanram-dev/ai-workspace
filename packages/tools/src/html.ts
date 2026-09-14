const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  copy: "©",
  reg: "®",
  trade: "™",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value < 0x110000 ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}

export interface ExtractedPage {
  title: string | null;
  text: string;
  links: { text: string; url: string }[];
}

/**
 * Lightweight readable-text extraction: drops scripts, styles and page chrome,
 * keeps headings, paragraphs and list items as lines, and collects links.
 * Not a full readability algorithm; interactive browsing arrives in Phase 6.
 */
export function extractReadableText(html: string, baseUrl: string, maxLinks = 30): ExtractedPage {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1];

  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|canvas|iframe|template|head|title)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(nav|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");

  const links: ExtractedPage["links"] = [];
  const seen = new Set<string>();
  body = body.replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const text = decodeEntities(inner.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    try {
      const url = new URL(decodeEntities(href), baseUrl);
      if ((url.protocol === "http:" || url.protocol === "https:") && text && !seen.has(url.href) && links.length < maxLinks) {
        seen.add(url.href);
        links.push({ text: text.slice(0, 120), url: url.href });
      }
    } catch {
      // Ignore malformed hrefs.
    }
    return ` ${inner} `;
  });

  const text = decodeEntities(
    body
      .replace(/<(br|hr)\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|h[1-6]|li|tr|blockquote|pre|header|main|table|ul|ol)>/gi, "\n")
      .replace(/<h([1-6])[^>]*>/gi, (_m, level: string) => `\n${"#".repeat(Number(level))} `)
      .replace(/<li[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v ]+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n")
    .trim();

  return { title: title ? decodeEntities(title).replace(/\s+/g, " ").trim() : null, text, links };
}
