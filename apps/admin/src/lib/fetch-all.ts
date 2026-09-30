/**
 * PostgREST answers at most `max_rows` (1000) rows per request and truncates the rest SILENTLY.
 * Screens that legitimately need every row (a stock matrix, a selector) page through with `.range()`
 * instead of trusting a single response, so a Central with thousands of products never loses rows.
 *
 * The query handed in MUST have a deterministic, unique ordering (add the id as the last sort key),
 * otherwise rows can repeat/skip between pages.
 */
export const FETCH_ALL_PAGE_SIZE = 1000;
const FETCH_ALL_MAX_PAGES = 100;

export async function fetchAllRows<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
): Promise<{ data: T[]; error: { message: string } | null }> {
  const rows: T[] = [];
  for (let page = 0; page < FETCH_ALL_MAX_PAGES; page += 1) {
    const from = page * FETCH_ALL_PAGE_SIZE;
    const { data, error } = await fetchPage(from, from + FETCH_ALL_PAGE_SIZE - 1);
    if (error) return { data: rows, error };
    const chunk = data ?? [];
    rows.push(...chunk);
    if (chunk.length < FETCH_ALL_PAGE_SIZE) return { data: rows, error: null };
  }
  return { data: rows, error: { message: `La consulta supera el máximo de ${String(FETCH_ALL_MAX_PAGES * FETCH_ALL_PAGE_SIZE)} filas` } };
}
