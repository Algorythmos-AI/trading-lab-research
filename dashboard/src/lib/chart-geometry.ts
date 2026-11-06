// Small pure helpers shared by the dashboard's own SVG charts (the review's day charts, the price ladder).
// Pure: no I/O, no React.

/**
 * Moves labels apart so none overlaps, keeping their order and staying inside [top, bottom]. In place: each label's
 * `y` is rewritten. With more labels than the room holds, the last pass wins and the top ones may sit above `top`.
 */
export function spread(ls: { y: number }[], gap: number, top: number, bottom: number): void {
  const sorted = [...ls].sort((a, b) => a.y - b.y);
  for (let i = 0; i < sorted.length; i++) sorted[i]!.y = Math.max(sorted[i]!.y, i ? sorted[i - 1]!.y + gap : top);
  for (let i = sorted.length - 1; i >= 0; i--) sorted[i]!.y = Math.min(sorted[i]!.y, i < sorted.length - 1 ? sorted[i + 1]!.y - gap : bottom);
}
