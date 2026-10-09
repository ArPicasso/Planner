// Pure helpers with no SDK imports, so they can be unit-tested locally.

// Splits "купить: матрас 160, шторы; роутер" into separate entries.
// Used when Claude is unavailable, and mirrored in the Mini App for instant pending rows.
export function splitItems(text) {
  let t = String(text || '').trim();
  t = t.replace(/^(купить|нужно купить|нужно|надо|need|buy|kaufen|einkaufen)\s*[:\-–—]?\s*/i, '');
  return t
    .split(/\n|;|,(?![^()]*\))(?!\d)/)
    .map((s) => s.replace(/^\s*(?:[-•*·]|\d+[.)])\s*/, '').trim())
    .filter((s) => s.length > 0)
    .slice(0, 50);
}

export function toNumber(x) {
  if (x == null || x === '') return null;
  const n = Number(String(x).replace(/[^\d,.\-]/g, '').replace(',', '.'));
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

export function toDate(x) {
  const s = String(x || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
