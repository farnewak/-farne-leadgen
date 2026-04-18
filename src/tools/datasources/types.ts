import type { PlaceCandidate } from "../../models/types.js";

// Common search contract all data sources must satisfy. Vienna scoping,
// rate-limiting, and source-specific quirks live inside each source.
export interface DataSourceSearchOptions {
  query: string;
  maxResults: number;
  plzFilter?: string | null;
}

export interface DataSource {
  // Stable machine id, used for logs and per-source metrics.
  id: string;
  // Human-readable label for operator-facing logs.
  label: string;
  // Runtime check — e.g. required env vars present.
  isConfigured(): boolean;
  // Returns candidates already normalized to PlaceCandidate.
  search(opts: DataSourceSearchOptions): Promise<PlaceCandidate[]>;
}
