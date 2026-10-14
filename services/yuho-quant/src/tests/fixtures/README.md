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

## Most-local fiscal-caption regression

The following excerpts preserve the original intervening table boundaries and
the closest printed fiscal range. They test stale prior/current words before
that range, rather than adding a caption or inferring a fiscal period. The HTML
intervals use JavaScript UTF-16 string offsets in the named original honbun file;
each has one provenance comment before the verbatim contiguous interval.

| Document / source URL | Actual body completion | Original ZIP bytes / SHA-256 | Honbun filename / interval |
| --- | --- | --- | --- |
| [S100Y53G](https://api.edinet-fsa.go.jp/api/v2/documents/S100Y53G?type=1) | Old HTTP acquisition clock UNKNOWN; existing physical archive read back during the 2026-10-02 JST run | 1,172,534 / `505f7a6558a6d3a6130835ec4c493f61f074e6b29965747af2366d780eeced4a` | `0105010_honbun_jpcrp030000-asr-001_E04912-000_2026-02-28_01_2026-05-19_ixbrl.htm` / `[1883290,1899869)` |
| [S100TYYR](https://api.edinet-fsa.go.jp/api/v2/documents/S100TYYR?type=1) | `2026-10-01T19:51:07.734Z` (2026-10-02 JST) | 1,700,880 / `b8742cc6636708e51a61bdae0958a4b42662fa1bba27897bda4431696c5b3f0d` | `0105010_honbun_jpcrp030000-asr-001_E01569-000_2024-03-31_01_2024-07-01_ixbrl.htm` / `[1054646,1077819)` |
| [S100FHUH](https://api.edinet-fsa.go.jp/api/v2/documents/S100FHUH?type=1) | `2026-10-01T19:51:46.364Z` (2026-10-02 JST) | 602,625 / `56a4e194423a34f886603db2054040e525fceeec48098343eb64e6dae2e5a277` | `0105110_honbun_jpcrp030000-asr-001_E02900-000_2018-12-31_01_2019-03-28_ixbrl.htm` / `[171525,182548)` |

Each XML fixture is a structural projection of the same filing's actual instance
root attributes and the uniquely referenced verbatim duration definitions, plus
root closure. It is assembled, not a claim to preserve the full original XML.
Y53G/TYYR contain actual `CurrentYearDuration` and `Prior1YearDuration`; FHUH
contains actual `CurrentYearDuration`. The reference names alone prove no period.
Credentials and complete ZIP files are excluded. LICENSE: original filing content
remains owned by its rights holders; these excerpts receive no new redistribution
license and are not relicensed under the repository's code license. Their use is
limited to actual-source regression. Negative transformations exist only in tests.

| Fixture | Bytes | SHA-256 |
| --- | ---: | --- |
| `context-fiscal-caption-S100Y53G.html` | 18,575 | `518c6a1094acb92d9fab70c6b0c5c7d6b03ccc8f80a4da06fb68444042eabdf4` |
| `duration-fiscal-caption-S100Y53G.xml` | 1,344 | `31e8ee1576082ab6bd547dce357c39987930eb40d561ceca9f4d8f2ed7609283` |
| `context-fiscal-caption-S100TYYR.html` | 25,431 | `0231eb3442356e777d8613fd8b5fecff6a541007a082e28ca55cb00c09b7a195` |
| `duration-fiscal-caption-S100TYYR.xml` | 1,303 | `74f1837a245d1ad62702b101e3dd64b4af64582fc6a7f8ff538f9d7b10db08f9` |
| `context-fiscal-caption-S100FHUH.html` | 11,699 | `531d639779e057a38a0400e891598107017f529aaccfd065d2bc95ff915528d0` |
| `duration-fiscal-caption-S100FHUH.xml` | 1,004 | `eafb3ef26e6e6586020dc5edf1fe8acef7e4533ea84794f96340fdbabc8b9b9e` |

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

## Explicit geographical Other regression (2026-10-14)

These three excerpts preserve the original current consolidated fiscal caption,
geographic-sales TextBlock, sole value row, and immediately following note.
1333 and 3036 explicitly classify the table by geography; 1860 lacks that note
and remains a negative example. A bare Other label does not qualify a region.
No amount, period, scope, caption, or note is injected into the source excerpt.
HTML fixtures have one provenance comment followed by the contiguous raw range.
XML fixtures assemble only actual root attributes and verbatim current/prior
duration definitions with the original root closure; they are structural
projections, not complete XML instances. Negative transformations occur in tests
only and are never treated as primary sources.

Original HTTP acquisition clocks and producer manifests are UNKNOWN for these
legacy archives. The saved ZIP full-byte verification and native DEI/period
qualification are separate receipts from this recovery run; no old manifest or
judgment-input hash is backfilled. Full ZIPs remain private.

LICENSE: original filing content remains owned by its rights holders. These
excerpts receive no new redistribution license and are not relicensed under the
repository code license. Use is limited to actual-source regression.

| Document / official source | Original ZIP bytes / SHA-256 | Honbun member / UTF-16 range |
| --- | --- | --- |
| [S100YCK1](https://api.edinet-fsa.go.jp/api/v2/documents/S100YCK1?type=1) / FY 2026-03-31 | 2,030,680 / `b24df1e403dab82c534bf5d1c0e5434c4ba3240ab0cd3a9ae68ae8cb8ddab439` | `XBRL/PublicDoc/0105010_honbun_jpcrp030000-asr-001_E00015-000_2026-03-31_01_2026-06-17_ixbrl.htm` / `[1550728,1558344)` |
| [S100YCV6](https://api.edinet-fsa.go.jp/api/v2/documents/S100YCV6?type=1) / FY 2026-03-31 | 671,807 / `c30ce4a65165ae4facb43bdecbec612fc22f650bcbd89a69e6b690de8689470d` | `XBRL/PublicDoc/0105010_honbun_jpcrp030000-asr-001_E02998-000_2026-03-31_01_2026-06-17_ixbrl.htm` / `[1485884,1495103)` |
| [S100YG3E](https://api.edinet-fsa.go.jp/api/v2/documents/S100YG3E?type=1) / FY 2026-03-31 | 1,442,842 / `9c42541a955a1bc5e4eb9e56dcd6208fed108857c86a4d90a069ad3f34f3f431` | `XBRL/PublicDoc/0105110_honbun_jpcrp030000-asr-001_E00147-000_2026-03-31_01_2026-06-22_ixbrl.htm` / `[120995,129810)` |

| Fixture | Bytes | SHA-256 |
| --- | ---: | --- |
| `geographic-other-S100YCK1.html` | 8,290 | `865dd91ff1e34e8e048b380ee035e35e9de644c3289250fa00fc94ece28616a7` |
| `geographic-other-S100YCK1.xml` | 1,469 | `921db28f131b2b74f74329e850add8caf69207e0bcc8378a2f40dbbfda29bdfc` |
| `geographic-other-S100YCV6.html` | 9,773 | `63c43287208148674a7bf5912b313d411eb0c893b13e77c05dc165a4d8176d72` |
| `geographic-other-S100YCV6.xml` | 1,469 | `2bcd08f22bfefe0b3ff3717aaffe61470d53321b46290175cd89302e518f56c5` |
| `geographic-other-S100YG3E.html` | 9,367 | `6d056da810c78e9c4b39d13f488daca2e2c2a5ac39c9ada5b4aaaaa3bcfa5701` |
| `geographic-other-S100YG3E.xml` | 1,469 | `42639de6743ed330e4e074237730aac59fc6cef1239e5d8e00c4fd0a19ba912d` |


## Explicit external-sales row and Other geography (S100Y4VB)

`geographic-external-row-S100Y4VB.html` is a verbatim contiguous excerpt of the
actual 3382 filing, FY2026-02-28. The local caption explicitly states the current
consolidated period. The table distinguishes external operating revenue from
inter-location revenue and operating profit. Its immediate note identifies the
country/region classification by geographical proximity and names Australia and
China in Other. Printed external `計` and `連結` are both 10,430,269 million JPY;
foreign leaves are 7,960,998 + 624,984 = 8,585,982. Their one-unit difference from
published total minus Japan remains unchanged.

Official source: [S100Y4VB type1](https://api.edinet-fsa.go.jp/api/v2/documents/S100Y4VB?type=1).
Original ZIP: 1,517,254 bytes, SHA-256
`9170e29c50f4c1e130bc0d79daf8b85ed87283d28bb2405c0e0c3a462eacfb81`.
Physical legacy archive page: `382d74ff-84cd-81fd-8a9f-d3f0ab7feed1`.
Original producer manifest and original HTTP acquisition clock remain unknown;
the saved metadata clock is not substituted for either.

Honbun member: `XBRL/PublicDoc/0105010_honbun_jpcrp030000-asr-001_E03462-000_2026-02-28_01_2026-05-20_ixbrl.htm`,
SHA-256 `75d7a5ec99085b6f4c545e3f03a2fe246f0d9ef68a3268d925c138e039b1c92e`.
Verbatim UTF-16 interval `[1798108,1816587)`; original fragment SHA-256
`1c2cc327d4eb019d0b1730ee2b8a37407ad190090f52bf5d460ed2307d5fe325`.
The XML fixture is a structural projection of original root attributes and
verbatim duration definitions, not a full original instance.

| Fixture | Bytes | SHA-256 |
| --- | ---: | --- |
| `geographic-external-row-S100Y4VB.html` | 19,712 | `a3a3abcb656cc1493e1bf39294760ac3f404d4eb8fd7275b791eff791fb5ef6d` |
| `geographic-external-row-S100Y4VB.xml` | 1,404 | `54cf45f37da91709d44bbab65682ded25c744433c75e2517622d9b8fd76c54f6` |

The preceding rights and regression-only conditions apply. Deliberate negative
transformations occur in tests, never in primary-source or production output.
