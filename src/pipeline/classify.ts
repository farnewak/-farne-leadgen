import type { Industry } from "../models/types.js";

// Precedence: primaryType wins, else first matching entry in types[].
// Categories tuned for the ICP (Vienna KMU, horizontal). "other" is the
// safe fallback, not a negative signal.
const TYPE_MAP: Record<string, Industry> = {
  // gastronomy
  restaurant: "gastronomy",
  cafe: "gastronomy",
  coffee_shop: "gastronomy",
  bar: "gastronomy",
  bakery: "gastronomy",
  meal_takeaway: "gastronomy",
  meal_delivery: "gastronomy",
  food: "gastronomy",
  fast_food_restaurant: "gastronomy",
  pizza_restaurant: "gastronomy",
  italian_restaurant: "gastronomy",
  chinese_restaurant: "gastronomy",
  japanese_restaurant: "gastronomy",
  night_club: "gastronomy",
  pub: "gastronomy",
  wine_bar: "gastronomy",
  ice_cream_shop: "gastronomy",

  // retail
  clothing_store: "retail",
  jewelry_store: "retail",
  book_store: "retail",
  shoe_store: "retail",
  electronics_store: "retail",
  furniture_store: "retail",
  home_goods_store: "retail",
  grocery_store: "retail",
  grocery_or_supermarket: "retail",
  convenience_store: "retail",
  department_store: "retail",
  shopping_mall: "retail",
  store: "retail",
  florist: "retail",
  pet_store: "retail",
  liquor_store: "retail",
  bicycle_store: "retail",
  sporting_goods_store: "retail",
  toy_store: "retail",
  gift_shop: "retail",
  hardware_store: "retail",
  supermarket: "retail",

  // services
  lawyer: "services",
  accounting: "services",
  insurance_agency: "services",
  real_estate_agency: "services",
  travel_agency: "services",
  bank: "services",
  atm: "services",
  post_office: "services",
  storage: "services",
  consulting: "services",
  marketing_agency: "services",
  tax_consultant: "services",
  notary: "services",

  // health
  doctor: "health",
  dentist: "health",
  pharmacy: "health",
  physiotherapist: "health",
  hospital: "health",
  veterinary_care: "health",
  medical_lab: "health",
  chiropractor: "health",
  optician: "health",
  psychologist: "health",
  health: "health",

  // beauty
  beauty_salon: "beauty",
  hair_care: "beauty",
  hair_salon: "beauty",
  spa: "beauty",
  nail_salon: "beauty",
  barber_shop: "beauty",
  massage: "beauty",

  // crafts / trades
  plumber: "crafts",
  electrician: "crafts",
  painter: "crafts",
  roofing_contractor: "crafts",
  locksmith: "crafts",
  car_repair: "crafts",
  car_wash: "crafts",
  car_dealer: "crafts",
  moving_company: "crafts",
  general_contractor: "crafts",
  carpenter: "crafts",
  upholsterer: "crafts",
  tailor: "crafts",
};

export function classifyIndustry(
  types: string[],
  primaryType: string | null,
): Industry {
  if (primaryType && TYPE_MAP[primaryType]) {
    return TYPE_MAP[primaryType];
  }
  for (const t of types) {
    const mapped = TYPE_MAP[t];
    if (mapped) return mapped;
  }
  return "other";
}

export function primaryCategoryKey(
  types: string[],
  primaryType: string | null,
): string {
  // Used by the dynamic chain-filter heuristic to decide whether two leads
  // with the same normalized name are plausibly the same chain (same category)
  // vs. coincidentally-named independent businesses.
  if (primaryType) return primaryType;
  return types[0] ?? "unknown";
}
