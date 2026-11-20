export interface LetterSection<T> {
  /** "A", or "J–L" when neighbouring letters were merged. */
  label: string;
  letters: string[];
  items: T[];
}

/** Letters are merged until a section has at least this many companies (one wide row). */
const MIN_SECTION = 3;

const letterOf = (name: string) => {
  const c = name.trim().charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
};

/**
 * Groups names by first letter, merging neighbouring sparse letters so no
 * section is a single orphan card. Expects items sorted by name.
 */
export function letterSections<T extends { name: string }>(
  items: readonly T[],
): LetterSection<T>[] {
  const byLetter = new Map<string, T[]>();
  for (const it of items) {
    const l = letterOf(it.name);
    byLetter.set(l, [...(byLetter.get(l) ?? []), it]);
  }
  const out: { letters: string[]; items: T[] }[] = [];
  let open: { letters: string[]; items: T[] } | null = null;
  for (const [letter, list] of byLetter) {
    open = open
      ? { letters: [...open.letters, letter], items: [...open.items, ...list] }
      : { letters: [letter], items: list };
    if (open.items.length >= MIN_SECTION) {
      out.push(open);
      open = null;
    }
  }
  // A short tail joins the section before it rather than standing alone.
  if (open) {
    const prev = out.pop();
    out.push(
      prev
        ? { letters: [...prev.letters, ...open.letters], items: [...prev.items, ...open.items] }
        : open,
    );
  }
  return out.map((s) => ({
    ...s,
    label:
      s.letters.length === 1 ? s.letters[0]! : `${s.letters[0]}–${s.letters[s.letters.length - 1]}`,
  }));
}
