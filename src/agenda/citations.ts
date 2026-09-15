const digits = '⁰¹²³⁴⁵⁶⁷⁸⁹';

/** The same source keeps its number throughout a document, including attachments. */
export function citationFormatter(sources: Record<string, { url: string }>) {
  const numbers = new Map<string, number>();
  const reference = (url: string, id = url) => {
    const key = url || id;
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    const label = String(numbers.get(key)).replace(/\d/g, n => digits[Number(n)]);
    return url ? `[${label}](${url})` : label;
  };
  return {
    sourceIds: (ids: string[]) => [...new Set(ids.map(id => reference(sources[id].url, id)))].join(' '),
    url: (url: string) => reference(url),
  };
}

// Only the numbered citation syntax is interpreted; other inline Markdown stays literal.
export const citationPattern = () => /(?<!\\)\[([⁰¹²³⁴⁵⁶⁷⁸⁹]+)\]\((https:\/\/[^\s<>\\()]+)\)/gu;
export const citationNumber = (label: string) => [...label].map(n => digits.indexOf(n)).join('');
