const UMLAUT_MAP: Record<string, string> = {
  ä: "ae",
  ö: "oe",
  ü: "ue",
  ß: "ss",
  Ä: "ae",
  Ö: "oe",
  Ü: "ue",
};

export function stripUmlauts(input: string): string {
  return input.replace(/[äöüßÄÖÜ]/g, (c) => UMLAUT_MAP[c] ?? c);
}

export function slugify(input: string): string {
  return stripUmlauts(input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, "-");
}

export function normName(input: string): string {
  return stripUmlauts(input)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+(gmbh|og|kg|eu|e\.u\.|e\.k\.|ag|ges\.m\.b\.h\.?)\b/g, "")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

export function districtFromPlz(plz: string | null): string | null {
  if (!plz || !/^1\d{3}$/.test(plz)) return null;
  const n = Number(plz.slice(1, 3));
  if (n < 1 || n > 23) return null;
  return String(n).padStart(2, "0");
}
