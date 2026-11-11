import type { DiscoverableServerData } from "stoat.js";

/**
 * Longest query the API accepts (`MAX_QUERY_LENGTH` in servers_list.rs);
 * longer strings are rejected with a 400, so clamp before sending.
 */
export const MAX_QUERY_LENGTH = 64;

/** One page of the public directory, as served by `GET /discover/servers` */
export interface DiscoverPage {
  servers: DiscoverableServerData[];
  total?: number;
}

/**
 * Fetch one page of the public directory. Raw fetch, unauthenticated: the
 * endpoint is public and the typed api package lags behind the fork's
 * routes (same reasoning as `DiscoverableServer.fetch`).
 */
export async function fetchDiscoverPage(
  baseURL: string,
  query: string,
  skip: number,
): Promise<DiscoverPage> {
  const params = new URLSearchParams();
  if (query) params.set("query", query.slice(0, MAX_QUERY_LENGTH));
  if (skip) params.set("skip", String(skip));
  const qs = params.toString();

  const response = await fetch(
    `${baseURL}/discover/servers${qs ? `?${qs}` : ""}`,
  );
  if (!response.ok) throw await response.json();
  return (await response.json()) as DiscoverPage;
}
