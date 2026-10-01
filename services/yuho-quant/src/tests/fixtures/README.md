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
