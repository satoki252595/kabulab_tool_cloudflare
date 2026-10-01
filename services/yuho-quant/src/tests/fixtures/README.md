# Overseas context regression provenance

These two fixtures are the minimal regression excerpts for the duration-context
change. They are not a complete filing or evidence of a production repair.

- Document: EDINET `S100YJVF`, FY ended `2026-03-31`, issuer `E37709-000`.
- Source URL: `https://api.edinet-fsa.go.jp/api/v2/documents/S100YJVF?type=1`
  (subscription credential deliberately omitted).
- Obtained: `2026-10-02` JST; response completed `2026-10-01T17:56:52.468Z`.
- Original ZIP: 884,834 bytes, SHA-256
  `41d3af026c1090c4dc92362005630992bbaebc08186f2a98a905951043d87d13`.
  The complete ZIP is private; the primary archive/full-byte verification is
  separate from these regression excerpts.
- LICENSE: original filing content remains owned by its rights holders. These
  excerpts receive no new redistribution license and are not relicensed under
  the repository's code license. Use here is limited to actual-source regression.

| Fixture | Derivation | SHA-256 |
| --- | --- | --- |
| `context-geography-S100YJVF.html` | Verbatim contiguous interval `[813135,899186)` of `0105010_honbun_jpcrp030000-asr-001_E37709-000_2026-03-31_01_2026-06-24_ixbrl.htm`, including the revenue-recognition and prior/current geography TextBlocks plus original intervening table boundaries. A provenance comment separates this 89,041-byte excerpt from the full filing. No fiscal caption is added. | `638bff77ae12b21fb395649a0621011215c37c7deae3dca702b610e6331a9739` |
| `duration-context-S100YJVF.xml` | Structural projection: actual instance root attributes, the two verbatim `Prior1YearDuration` / `CurrentYearDuration` definitions, root closure. Actual header definitions independently agree. This assembled projection is not the original XML file. | `5b233379ed069c5e3ebab61841bec2510c72d2255db6b6b7287e2df6bfa47ff0` |

Negative tests explicitly transform these fixtures in memory. They do not claim
to be EDINET source data and never reach production output or persistence.

## Visible metric-heading regression

These two formal excerpts retain the original sales table, intervening metric
title and unit-only layout table, and noncurrent-assets table. They test the
nearest visible title across long HTML style attributes. Each fixture has one
provenance comment followed by a verbatim contiguous UTF-16 interval of the
named original honbun. No original amount, period, scope, or title is injected
or changed. These excerpts are not whole-filing qualification or a production
repair. Complete ZIPs and credentials remain private.

LICENSE: original filing content remains owned by its rights holders; these
excerpts receive no new redistribution license and are not relicensed under the
repository code license. Use is limited to actual-source regression. Tests mark
negative transformations explicitly; those transformed inputs are not sources.

| Document / source URL | Actual body completion (2026-10-02 JST) | Original ZIP bytes / SHA-256 | Honbun filename / UTF-16 interval |
| --- | --- | --- | --- |
| [S100GAYK](https://api.edinet-fsa.go.jp/api/v2/documents/S100GAYK?type=1) | `2026-10-01T19:51:39.673Z` | 781,506 / `d71969f492387fe2964d35db89bdc7e61ae04af2daf8932567ea69bab8f9d4d4` | `0105010_honbun_jpcrp030000-asr-001_E03724-000_2019-03-31_01_2019-06-27_ixbrl.htm` / `[833027,848438)` |
| [S100W2ZR](https://api.edinet-fsa.go.jp/api/v2/documents/S100W2ZR?type=1) | `2026-10-01T19:51:00.855Z` | 2,483,117 / `6263197a7a180a084b73645b90a33af1557f1270f0140f7205103e3638c8b277` | `0105010_honbun_jpcrp030000-asr-001_E01914-000_2025-03-31_01_2025-06-24_ixbrl.htm` / `[568085,587955)` |

| Fixture | Bytes | SHA-256 |
| --- | ---: | --- |
| `metric-heading-pair-S100GAYK.html` | 15,929 | `3e19d143cf52de07079811fcdd90a003544704259f9828f8f2b2839f8c0f8689` |
| `metric-heading-pair-S100W2ZR.html` | 20,612 | `761fc5dd53c6b42ea9225153083654b577a12ee9099feef81aca5730ed972c03` |
