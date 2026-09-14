const DEFAULT_TITLE = "New conversation";

/** Derives a short single-line conversation title from the first user message. */
export function deriveConversationTitle(content: string, maxLength = 60): string {
  const singleLine = content.replace(/\s+/g, " ").trim();
  if (!singleLine) return DEFAULT_TITLE;
  if (singleLine.length <= maxLength) return singleLine;
  const cut = singleLine.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
