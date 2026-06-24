// Tag color system — locked at D-022.
//
//   TAG_COLORS  → saturated chip/pill/accent color
//   TAG_BG      → pastel note-background color
//
// Known tags get a hand-tuned pair. Unknown tags fall back to a deterministic
// pastel based on the tag name (so the same tag always gets the same color).

export const TAG_COLORS: Record<string, string> = {
  todo:             '#C8102E',
  shop:             '#E8704A',
  idea:             '#003B8E',
  board:            '#0F766E',
  thought:          '#6E3CBC',
  infra:            '#44403C',
  lesson:           '#C99700',
  reminder:         '#2D6A4F',
  people:           '#B8336A',
  'hot-take':       '#DC2626',
  transportation:   '#0E7490',  // deep cyan — highway/transit blue, hue-shifted from idea/board
  'watch-list':     '#581C87',  // aubergine — darker + redder than thought lavender
};

export const TAG_BG: Record<string, string> = {
  todo:             '#FBE5E9',
  shop:             '#FCEAD7',
  idea:             '#DEE6F2',
  board:            '#DBEBE9',
  thought:          '#ECE4F5',
  infra:            '#EDEBE8',
  lesson:           '#F7EDD0',
  reminder:         '#DEEDDB',
  people:           '#F1DCE5',
  'hot-take':       '#FCDDDD',
  transportation:   '#CFEAEF',  // light cyan paired with #0E7490
  'watch-list':     '#E9D8F0',  // light orchid paired with #581C87
};

// Fallback palette for tags we haven't named. Pairs are (chip, bg).
// Designed to coexist with the named palette without clashing.
const FALLBACK_PALETTE: Array<[string, string]> = [
  ['#1F2937', '#E5E7EB'],   // slate
  ['#7C2D12', '#FEE5D5'],   // brown
  ['#365314', '#E7F0D6'],   // olive
  ['#075985', '#DBEAFE'],   // steel
  ['#86198F', '#F5D5F0'],   // magenta
  ['#9A3412', '#FEEAD2'],   // rust
  ['#1E3A8A', '#DCE5F5'],   // navy
  ['#134E4A', '#D5EAE7'],   // teal-deep
];

function hashString(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = (h * 33) ^ s.charCodeAt(i);
  return Math.abs(h | 0);
}

function fallback(tag: string): [string, string] {
  return FALLBACK_PALETTE[hashString(tag) % FALLBACK_PALETTE.length]!;
}

export function tagColor(tag: string): string {
  return TAG_COLORS[tag] ?? fallback(tag)[0];
}

export function tagBg(tag: string): string {
  return TAG_BG[tag] ?? fallback(tag)[1];
}

/** The note's background is its primary (first) tag's pastel.
 *  No tags → defer to the CSS variable `--paper-2` (light-NERV cream paper,
 *  currently #EFEAD9). Returning the var expression instead of a hex means
 *  future palette tweaks in board.css automatically flow through to untagged
 *  notes. History: hardcoded `#f5f5f4` (stone-100) before D-030; fixed in
 *  f426de4 to use `var(--paper-2)`; desaturated to #EFEAD9 in d95b3a7. */
export function noteBgFor(tags: string[]): string {
  if (tags.length === 0) return 'var(--paper-2)';
  return tagBg(tags[0]!);
}

