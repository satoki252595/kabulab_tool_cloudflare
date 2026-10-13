"""保存EDINET ZIPから必要な実factだけを切り出す。取得・表生成・値改変はしない。"""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pandas as pd
from lxml import etree

from jp_stock_pipeline.convert.xbrl_to_csv import xbrl_zip_to_tidy

ROOT = Path(__file__).resolve().parents[2]
TARGETS = {
    "6963": ("S100YF41", "E01953"),
    "8014": ("S100YBIN", "E02509"),
    "8593": ("S100YF4V", "E04788"),
}
ZIP_SHA = {
    "6963": "84cc6e927d5d1d282c5bc845b3dbe2c1dbd9bd390291f5dde37ce0f75d4e6fe6",
    "8014": "160cae1fed1392bddf45781e7e8fd63263cdd04b12ab81971f8625ef5d90f1d9",
    "8593": "c8d5f6358461b4f88b57664a9daec3e9680a5634a28fb8e4ada9a82d675a8294",
}
MDA = "ManagementAnalysisOfFinancialPositionOperatingResultsAndCashFlowsTextBlock"
BLOCKS = {
    "6963": {MDA},
    "8014": {MDA},
    "8593": {MDA, "BusinessPolicyBusinessEnvironmentIssuesToAddressEtcTextBlock", "RemunerationForDirectorsAndOtherOfficersTextBlock"},
}
DEI = {
    "EDINETCodeDEI",
    "SecurityCodeDEI",
    "FilerNameInJapaneseDEI",
    "CurrentPeriodEndDateDEI",
    "CurrentFiscalYearEndDateDEI",
    "CurrentFiscalYearStartDateDEI",
    "TypeOfCurrentPeriodDEI",
    "WhetherConsolidatedFinancialStatementsArePreparedDEI",
}
OUT = ROOT / "pipeline/tests/fixtures/direct-roa-table"


def sha(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def main():
    OUT.mkdir(exist_ok=True)
    provenance = []
    for code, (doc, issuer) in TARGETS.items():
        path = (
            ROOT
            / "tmp/feature-audit-20261013/direct-roa-saved-type1-legacy-v2"
            / f"{code}-{doc}.zip"
        )
        content = path.read_bytes()
        assert sha(content) == ZIP_SHA[code]
        receipt = json.loads(path.with_suffix(".receipt.json").read_text())
        with zipfile.ZipFile(path) as archive:
            members = [n for n in archive.namelist() if "/PublicDoc/" in n and n.endswith(".xbrl")]
            assert len(members) == 1
            member = members[0]
            assert f"_{issuer}-" in member and "_2026-03-31_" in member
            original = archive.read(member)
        root = etree.fromstring(original)
        tidy = xbrl_zip_to_tidy(content, code, doc)
        keep = tidy.element.map(
            lambda e: (
                e.startswith("jpdei_cor:")
                and e.split(":")[-1] in DEI
            or e.startswith("jpcrp_cor:")
            and e.split(":")[-1] in BLOCKS[code]
            )
        )
        # normalizer の連結区分も実原典の当期連結factで確定させる。
        flow = tidy.element.eq("jppfs_cor:NetSales") & tidy.context_ref.eq("CurrentYearDuration")
        native_flow = tidy[flow].drop_duplicates()
        assert len(native_flow) == 1
        selected = pd.concat([tidy[keep & tidy.context_ref.eq("FilingDateInstant")], native_flow])
        assert selected.element.is_unique
        rows = selected.to_dict("records")
        facts = []
        for row in rows:
            nodes = [
                el
                for el in root.iter("*")
                if el.get("contextRef") == row["context_ref"]
                and f"{el.prefix}:{etree.QName(el).localname}" == row["element"]
            ]
            assert nodes and all(el.text == row["value"] for el in nodes)
            facts.append(
                {
                    "element": row["element"],
                    "context": row["context_ref"],
                    "valueSHA256": sha(row["value"].encode()),
                    "serializedElementsSHA256": [sha(etree.tostring(el)) for el in nodes],
                    "nativeDuplicateCount": len(nodes),
                }
            )
        payload = (json.dumps(rows, ensure_ascii=False, indent=2) + "\n").encode()
        name = f"{code}-{doc}.json"
        (OUT / name).write_bytes(payload)
        context_ids = set(selected.context_ref)
        contexts = [
            el
            for el in root.iter("*")
            if etree.QName(el).localname == "context" and el.get("id") in context_ids
        ]
        assert len(contexts) == len(context_ids)
        company = next(r["value"] for r in rows if r["element"].endswith(":FilerNameInJapaneseDEI"))
        provenance.append(
            {
                "fixture": name,
                "fixtureKind": "mechanically selected original tidy facts; partial document, not full ZIP; no synthesized table or value",
                "source": "EDINET",
                "license_tag": "commercial-ok",
                "sourceFetchedAt": receipt["metadata"]["fetchedAt"],
                "originalExpectedSHAAvailable": receipt["originalExpectedSHAAvailable"],
                "independentPriorSHACompared": receipt["independentPriorSHACompared"],
                "docID": doc,
                "code": code,
                "edinetCode": issuer,
                "company": company,
                "fiscalYearEnd": "2026-03-31",
                "url": f"https://api.edinet-fsa.go.jp/api/v2/documents/{doc}?type=1",
                "fullZIPBytes": len(content),
                "fullZIPSHA256": sha(content),
                "member": member,
                "memberSHA256": sha(original),
                "cutoutSHA256": sha(payload),
                "contexts": [
                    {
                        "id": el.get("id"),
                        "serializedXML": etree.tostring(el, encoding="unicode"),
                        "serializedSHA256": sha(etree.tostring(el)),
                    }
                    for el in contexts
                ],
                "facts": facts,
            }
        )
    (OUT / "provenance.json").write_text(
        json.dumps(provenance, ensure_ascii=False, indent=2) + "\n"
    )
    print(f"saved {len(provenance)} actual EDINET fact cutouts; source GETs=0")


if __name__ == "__main__":
    main()
