import type { PlaceCandidate } from "../../models/types.js";
import { districtFromPlz } from "../../lib/normalize.js";
import {
  OSM_TAG_TO_GPLACES_KEY,
  findOsmTagKey,
} from "../../pipeline/classify-osm.js";

export interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OverpassResponse {
  elements?: OverpassElement[];
}

function buildAddress(tags: Record<string, string>): string | null {
  const street = tags["addr:street"];
  const number = tags["addr:housenumber"];
  const postcode = tags["addr:postcode"];
  const city = tags["addr:city"];
  const parts: string[] = [];
  if (street) parts.push(number ? `${street} ${number}` : street);
  const loc = [postcode, city].filter(Boolean).join(" ");
  if (loc) parts.push(loc);
  return parts.length > 0 ? parts.join(", ") : null;
}

export function elementToCandidate(
  el: OverpassElement,
): PlaceCandidate | null {
  const tags = el.tags ?? {};
  const rawOsmKey = findOsmTagKey(tags);
  if (!rawOsmKey) return null;
  const primaryType = OSM_TAG_TO_GPLACES_KEY[rawOsmKey];
  if (!primaryType) return null;

  const name = tags.name ?? tags.brand ?? null;
  if (!name) return null;

  const plz = tags["addr:postcode"] ?? null;
  const types: string[] = [rawOsmKey];
  const brandValue = tags.brand ?? tags["brand:wikidata"];
  if (brandValue) types.push(`brand:${brandValue}`);

  return {
    placeId: `osm:${el.type}:${el.id}`,
    name,
    address: buildAddress(tags),
    plz,
    district: districtFromPlz(plz),
    types,
    primaryType,
    website: tags.website ?? tags["contact:website"] ?? null,
    phone: tags.phone ?? tags["contact:phone"] ?? null,
    lat: el.lat ?? el.center?.lat ?? 0,
    lng: el.lon ?? el.center?.lon ?? 0,
  };
}
