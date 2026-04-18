// OSM-tag ("{key}={value}") → Google-Places primary-type key.
// Feed the result into classifyIndustry() for the industry bucket.
//
// IMPORTANT: Do NOT extend this map ad-hoc. Run a quarterly Discovery-Mode
// pass (explorative nwr[key](area.wien) queries without value filter) to
// surface new categories, then curate additions in a dedicated commit.
export const OSM_TAG_TO_GPLACES_KEY: Readonly<Record<string, string>> = {
  // gastronomy
  "amenity=restaurant": "restaurant",
  "amenity=cafe": "cafe",
  "amenity=bar": "bar",
  "amenity=pub": "pub",
  "amenity=fast_food": "fast_food_restaurant",
  "amenity=ice_cream": "ice_cream_shop",
  "shop=bakery": "bakery",

  // retail
  "shop=clothes": "clothing_store",
  "shop=shoes": "shoe_store",
  "shop=jewelry": "jewelry_store",
  "shop=books": "book_store",
  "shop=electronics": "electronics_store",
  "shop=florist": "florist",
  "shop=furniture": "furniture_store",
  "shop=hardware": "hardware_store",
  "shop=bicycle": "bicycle_store",
  "shop=gift": "gift_shop",
  "shop=convenience": "convenience_store",
  "shop=supermarket": "supermarket",

  // services
  "office=lawyer": "lawyer",
  "office=accountant": "accounting",
  "office=tax_advisor": "tax_consultant",
  "office=insurance": "insurance_agency",
  "office=estate_agent": "real_estate_agency",
  "office=travel_agent": "travel_agency",
  "office=notary": "notary",

  // health
  "amenity=doctors": "doctor",
  "amenity=dentist": "dentist",
  "amenity=pharmacy": "pharmacy",
  "amenity=veterinary": "veterinary_care",
  "healthcare=physiotherapist": "physiotherapist",
  "healthcare=optometrist": "optician",
  "shop=optician": "optician",
  "healthcare=psychotherapist": "psychologist",

  // beauty
  "shop=hairdresser": "hair_salon",
  "shop=beauty": "beauty_salon",
  "shop=cosmetics": "beauty_salon",
  "amenity=spa": "spa",
  "leisure=spa": "spa",

  // crafts / trades
  "craft=plumber": "plumber",
  "craft=electrician": "electrician",
  "craft=painter": "painter",
  "craft=carpenter": "carpenter",
  "craft=roofer": "roofing_contractor",
  "craft=locksmith": "locksmith",
  "craft=tailor": "tailor",
  "craft=upholsterer": "upholsterer",
  "shop=car_repair": "car_repair",
  "amenity=car_wash": "car_wash",
};

// Resolve the (key, value) pair an element brings to the query match.
// Returns the first map-key whose tag is present on the element.
// Deterministic order: iterates OSM_TAG_TO_GPLACES_KEY as defined above.
export function findOsmTagKey(
  tags: Readonly<Record<string, string>>,
): string | null {
  for (const mapKey of Object.keys(OSM_TAG_TO_GPLACES_KEY)) {
    const [k, v] = mapKey.split("=");
    if (k && v && tags[k] === v) return mapKey;
  }
  return null;
}
