/**
 * Server-side table state: search + sort + pagination from the query string.
 *   const t = tableState(req, { sortable: { name: "e.last_name", dept: "d.name" }, defaultSort: "name" });
 *   ... ORDER BY ${t.orderBy} LIMIT ${t.limit} OFFSET ${t.offset}
 * `sortable` is a whitelist (key -> SQL column), so user input never reaches the ORDER BY clause.
 */
export function tableState(req, { sortable = {}, defaultSort, defaultDir = "asc", perPage = 15, maxPerPage = 100 } = {}) {
  const q = String(req.query.q || "").trim().slice(0, 100);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const per = Math.min(maxPerPage, Math.max(5, parseInt(req.query.per, 10) || perPage));
  const sortKey = Object.hasOwn(sortable, req.query.sort) ? req.query.sort : defaultSort;
  const dir = (req.query.dir || defaultDir).toLowerCase() === "desc" ? "desc" : "asc";
  const col = sortable[sortKey] || Object.values(sortable)[0] || "1";
  return {
    q, page, per, sort: sortKey, dir,
    limit: per,
    offset: (page - 1) * per,
    orderBy: `${col} ${dir.toUpperCase()}`,
    sortable: Object.keys(sortable),
  };
}

// Builds the view model consumed by the {{> pager}} partial and sortable headers.
export function tableMeta(req, t, total, extraParams = {}) {
  const pages = Math.max(1, Math.ceil(total / t.per));
  const page = Math.min(t.page, pages);
  const base = { ...extraParams, q: t.q || undefined, per: t.per !== 15 ? t.per : undefined, sort: t.sort, dir: t.dir };
  const qs = (over) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...base, ...over })) if (v !== undefined && v !== "" && v !== null) p.set(k, v);
    const s = p.toString();
    return req.baseUrl + req.path + (s ? "?" + s : "");
  };
  const window = [];
  for (let i = Math.max(1, page - 2); i <= Math.min(pages, page + 2); i++) window.push({ n: i, url: qs({ page: i }), current: i === page });
  return {
    total, page, pages,
    from: total ? (page - 1) * t.per + 1 : 0,
    to: Math.min(total, page * t.per),
    prevUrl: page > 1 ? qs({ page: page - 1 }) : null,
    nextUrl: page < pages ? qs({ page: page + 1 }) : null,
    firstUrl: qs({ page: 1 }), lastUrl: qs({ page: pages }),
    window, showPager: total > t.per,
    // sortable header helper: sortUrl("name") flips direction when already sorted by that column
    sortUrl: (key) => qs({ sort: key, dir: t.sort === key && t.dir === "asc" ? "desc" : "asc", page: 1 }),
    sortState: (key) => (t.sort === key ? t.dir : ""),
  };
}

export const likeTerm = (q) => `%${q.replace(/[\\%_]/g, "\\$&")}%`;
