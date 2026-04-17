# farne-leadgen — config

## `chain-blocklist.yaml`

Statische Allowlist-per-Default-Negativliste fuer die Ketten-/Franchise-Erkennung.
Leads, deren normalisierter Name in dieser Liste als Substring matcht, werden
mit `chainFlag = 'blocklisted'` markiert und vom Dashboard per Default
ausgeblendet (Filter "Suspected Chains" zeigt sie trotzdem an).

### Matching-Regeln

- case-insensitive
- Umlaute gestripped (ae/oe/ue/ss)
- Match via `slugify(name).includes(blocklistEntry)` — also Substring, nicht exakt

Beispiel: `"Filialleitung Bäckerei Felber 1070"` → `slugify` → `filialleitung-baeckerei-felber-1070` → enthaelt `felber` → blocklisted.

### Kategorien

Die `retail` / `gastronomy` / `other`-Gruppen dienen aktuell nur der
Lesbarkeit; das Matching geht ueber alle Gruppen gleich.

### Dynamische Heuristik (ergaenzend)

Siehe `src/pipeline/chainfilter.ts`. Grobe Regel:

```
if (vienna_locations(normName, primaryPlacesCategory) > 3
    AND verteilt ueber >= 3 distinct Bezirke)
  → chainFlag = 'suspected_chain'
  → status bleibt 'new' (manuelle Review im Dashboard)
```

Reine Namens-Frequenz wird bewusst NICHT als Chain-Signal gewertet — "Café
Schwarz", "Pizzeria Roma", "Friseur Anna" kommen haeufig vor ohne Ketten zu
sein.

### Beitragen

1. PR gegen dieses File
2. Neue Eintraege in die passende Kategorie, klein geschrieben
3. Begruendung im PR-Body (Kettenname, geschaetzte Filialzahl in Wien)
4. Unit-Test in `tests/unit/chainfilter.test.ts` mit dem normalisierten Namen

**Nicht** hinzufuegen:

- Einzelbetriebe (auch wenn sie mehrere Standorte haben — z.B. zwei Filialen
  eines lokalen Juweliers ist keine Kette im ICP-Sinn)
- Marken ohne eigene Ladenpraesenz in Wien
- Dienstleister (Banken, Versicherungen, Netzbetreiber) — die werden per
  Industry-Filter im Scoring behandelt, nicht per Blocklist

### Override in der DB

Manuelle Overrides pro Lead werden in der Tabelle `chain_overrides`
persistiert und ueberschreiben sowohl statische als auch dynamische
Entscheidungen. Setzbar via Dashboard.

| verdict        | Bedeutung                                       |
|----------------|-------------------------------------------------|
| `whitelist`    | ist KEINE Kette, Lead bleibt drin               |
| `blacklist`    | ist eine Kette, Lead permanent `dismissed`      |
