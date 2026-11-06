export type DiffLine = { kind: "same" | "add" | "del"; text: string };

// Past this many changed lines the table would cost too much memory in a browser tab.
const MAX_MIDDLE = 2000;

// lineDiff: `before` to `after`, by longest common subsequence. Null when the files are too large to compare.
export function lineDiff(before: string, after: string): DiffLine[] | null {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const n = endA - start;
  const m = endB - start;
  if (n > MAX_MIDDLE || m > MAX_MIDDLE) return null;

  const width = m + 1;
  const lcs = new Uint16Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] = a[start + i] === b[start + j]
        ? (lcs[(i + 1) * width + j + 1] ?? 0) + 1
        : Math.max(lcs[(i + 1) * width + j] ?? 0, lcs[i * width + j + 1] ?? 0);
    }
  }

  const out: DiffLine[] = a.slice(0, start).map((text) => ({ kind: "same", text }));
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[start + i] === b[start + j]) {
      out.push({ kind: "same", text: a[start + i] ?? "" });
      i++;
      j++;
    } else if (j < m && (i === n || (lcs[i * width + j + 1] ?? 0) >= (lcs[(i + 1) * width + j] ?? 0))) {
      out.push({ kind: "add", text: b[start + j] ?? "" });
      j++;
    } else {
      out.push({ kind: "del", text: a[start + i] ?? "" });
      i++;
    }
  }
  for (const text of a.slice(endA)) out.push({ kind: "same", text });
  return out;
}
