"""EDINETコードリスト収集 (§2.1, P1) のテスト。

フィクスチャ pipeline/tests/fixtures/edinet/Edinetcode.zip は 2026-06-10 に
公開URLから実取得した実レスポンス（捏造禁止 §3-6）。
"""

from __future__ import annotations

import io
import zipfile
from datetime import date

import pytest
from conftest import fixture_path

from jp_stock_pipeline.collectors import edinet_codelist as mod
from jp_stock_pipeline.config import load_settings
from jp_stock_pipeline.licensing import LicenseTag
from jp_stock_pipeline.models import ConvertStatus, Source
from jp_stock_pipeline.rawstore import save_raw

ZIP_FIXTURE = "edinet/Edinetcode.zip"


def _zip_bytes() -> bytes:
    return fixture_path(ZIP_FIXTURE).read_bytes()


class TestNormalizeSecCode:
    def test_five_digits_trailing_zero(self):
        assert mod.normalize_sec_code("72030") == "7203"

    def test_new_style_alphanumeric(self):
        # 新方式コード（英字含み）も末尾0の5桁 → 4桁化（実コードリストに存在する形式）
        assert mod.normalize_sec_code("409A0") == "409A"

    def test_four_digits_kept(self):
        assert mod.normalize_sec_code("7203") == "7203"

    def test_missing_is_none(self):
        # 欠損は欠損のまま (§3-1)
        assert mod.normalize_sec_code(None) is None
        assert mod.normalize_sec_code("") is None
        assert mod.normalize_sec_code("  ") is None

    def test_不正な形式を素通しせずNoneにする(self):
        """仕様変更（厳格化）。

        旧実装は「末尾0の5桁だけ4桁化し、それ以外は**入力をそのまま返す**」
        だったため、妥当性を一切検証しない素通しになっていた。呼び出し側
        (`edinet.py:209` の scope / `:246` の code 列) は不正なコードを
        正常値として受け取っていた。
        """
        assert mod.normalize_sec_code("720") is None  # 桁不足
        assert mod.normalize_sec_code("7203.T") is None  # サフィックス付き
        assert mod.normalize_sec_code("A130") is None  # 1桁目英字
        assert mod.normalize_sec_code("1234567") is None  # 桁過多

    def test_種類株コードを普通株に丸めない(self):
        # 伊藤園第1種優先株式。末尾非0なので4桁化しない。
        # 旧実装はここも素通しで "25935" を返しており、呼び出し側で
        # 5文字コードのまま core_stocks を引いて不一致になっていた。
        assert mod.normalize_sec_code("25935") is None

    def test_表記揺れは吸収する(self):
        # 旧実装は大文字化・全角半角化をしておらず、同じ銘柄が表記違いで
        # 別コードになりうる（TDnet 側の実装とも割れていた）。
        assert mod.normalize_sec_code("409a0") == "409A"
        assert mod.normalize_sec_code("７２０３") == "7203"


class TestParseCodelist:
    def test_parses_listed_companies(self):
        records = mod.parse_codelist(_zip_bytes())
        # 全上場銘柄は約3,900社 (§1)
        assert len(records) > 3000
        assert all(r.listed for r in records)
        # 証券コードは4桁化済み（コードリストの実データは全件5桁・末尾0）
        assert all(len(r.code) == 4 for r in records)

    def test_toyota_7203(self):
        records = mod.parse_codelist(_zip_bytes())
        by_code = {r.code: r for r in records}
        toyota = by_code["7203"]
        assert toyota.name == "トヨタ自動車株式会社"
        assert toyota.edinet_code == "E02144"
        assert toyota.sector33 == "輸送用機器"

    def test_provenance(self):
        records = mod.parse_codelist(_zip_bytes(), raw_page_id="page-123")
        prov = records[0].provenance
        assert prov.source is Source.EDINET
        assert prov.license_tag is LicenseTag.COMMERCIAL_OK  # §2.1
        # データ基準日はメタ行（1行目）の「YYYY年MM月DD日現在」から取る
        assert isinstance(prov.data_date, date)
        assert prov.fetched_at.tzinfo is not None
        assert prov.raw_page_id == "page-123"

    def test_cp932_decodable(self):
        # zip 内 CSV が cp932 で読めること（実物の文字コード確認）
        text = mod._read_codelist_csv(_zip_bytes())
        assert "ＥＤＩＮＥＴコード" in text
        assert "証券コード" in text


def _make_zip(files: dict[str, str]) -> bytes:
    """敵対ケース用の最小 zip を組む（実フィクスチャの代替ではなく検証ベクタ）。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        for name, text in files.items():
            zf.writestr(name, text.encode("cp932"))
    return buf.getvalue()


def _mutate_fixture_line3(old_tail: str, new_tail: str) -> bytes:
    """実フィクスチャ CSV の 3 行目 (先頭データ行) の末尾だけを置換して zip 化。

    他の全行は実物のまま。置換対象の不一致は assert で落とす
    (fixture 変更時の黙って通過を防ぐ)。
    """
    text = mod._read_codelist_csv(_zip_bytes())
    lines = text.split("\n")
    assert lines[2].endswith(old_tail), "fixture line3 tail changed"
    lines[2] = lines[2][: -len(old_tail)] + new_tail
    return _make_zip({"EdinetcodeDlInfo.csv": "\n".join(lines)})


_TRUST_META = "ダウンロード実行日,2026年09月30日現在,件数,1件"
_TRUST_HEADER = (
    "ＥＤＩＮＥＴコード,提出者種別,上場区分,連結の有無,資本金,決算日,"
    "提出者名,提出者名（英字）,提出者名（ヨミ）,所在地,提出者業種,"
    "証券コード,提出者法人番号"
)
_TRUST_ROW = "E12345,,上場,,1000,,テスト株式会社,,,,サービス業,72030,"


class TestTrustBoundary:
    def test_複数CSVは先頭採用せずSTOP(self):
        data = _make_zip(
            {
                "EdinetcodeDlInfo.csv": f"{_TRUST_META}\n{_TRUST_HEADER}\n{_TRUST_ROW}\n",
                "Extra.csv": "a,b\n1,2\n",
            }
        )
        with pytest.raises(ValueError, match="想定と不一致"):
            mod.parse_codelist(data)

    def test_別名CSVのみはSTOP(self):
        data = _make_zip({"Other.csv": f"{_TRUST_META}\n{_TRUST_HEADER}\n{_TRUST_ROW}\n"})
        with pytest.raises(ValueError, match="想定と不一致"):
            mod.parse_codelist(data)

    def test_CSV不在はSTOP(self):
        data = _make_zip({"notes.txt": "no csv here"})
        with pytest.raises(ValueError, match="想定と不一致"):
            mod.parse_codelist(data)

    def test_重複ヘッダはSTOP(self):
        dup_header = _TRUST_HEADER.replace("提出者法人番号", "証券コード")
        data = _make_zip(
            {"EdinetcodeDlInfo.csv": f"{_TRUST_META}\n{dup_header}\n{_TRUST_ROW}\n"}
        )
        with pytest.raises(ValueError, match="ヘッダ名が重複"):
            mod.parse_codelist(data)

    def test_非空白の列不足行はSTOP(self):
        data = _make_zip(
            {"EdinetcodeDlInfo.csv": f"{_TRUST_META}\n{_TRUST_HEADER}\nE99999,,上場\n"}
        )
        with pytest.raises(ValueError, match="3行目.*列不足"):
            mod.parse_codelist(data)

    def test_完全な空白行のみスキップ(self):
        data = _make_zip(
            {
                "EdinetcodeDlInfo.csv": (
                    f"{_TRUST_META}\n{_TRUST_HEADER}\n{_TRUST_ROW}\n\n{_TRUST_ROW}\n"
                )
            }
        )
        records = mod.parse_codelist(data)
        assert len(records) == 2

    def test_実フィクスチャは単一CSVと一意ヘッダと全行同幅(self):
        """実物の前提を固定する（敵対ベクタではなく実測の錨）。"""
        import csv as _csv

        with zipfile.ZipFile(io.BytesIO(_zip_bytes())) as zf:
            assert zf.namelist() == ["EdinetcodeDlInfo.csv"]
        rows = list(_csv.reader(io.StringIO(mod._read_codelist_csv(_zip_bytes()))))
        assert len(rows[1]) == len(set(rows[1]))
        width = len(rows[1])
        assert all(len(r) == width or not any(c.strip() for c in r) for r in rows[2:])

    def test_実物由来の最終列truncateはSTOP(self):
        """実フィクスチャの先頭データ行の最終列 (法人番号) 欠落は STOP。

        旧実装は必要列 (証券コード) より後ろの欠落を見逃していた。
        """
        import csv as _csv

        data = _mutate_fixture_line3(',"5070001000715"\r', "\r")
        line3 = mod._read_codelist_csv(data).split("\n")[2]
        assert len(next(_csv.reader([line3]))) == 12  # ベクタの自己検証
        with pytest.raises(ValueError, match="3行目.*列不足"):
            mod.parse_codelist(data)

    def test_実物由来の余分列はSTOP(self):
        """実フィクスチャの先頭データ行への余分列の付加は STOP。

        旧実装はヘッダより長い行の余分を黙殺していた。
        """
        import csv as _csv

        data = _mutate_fixture_line3("\r", ',"余分"\r')
        line3 = mod._read_codelist_csv(data).split("\n")[2]
        assert len(next(_csv.reader([line3]))) == 14  # ベクタの自己検証
        with pytest.raises(ValueError, match="3行目.*列過多"):
            mod.parse_codelist(data)

    def test_ヘッダ拡張は同幅なら正常(self):
        """列追加のヘッダ (一意＋必須名あり) と同幅の行は拒否しない。"""
        ext_header = _TRUST_HEADER + ",新列"
        ext_row = _TRUST_ROW + ",x"
        data = _make_zip(
            {"EdinetcodeDlInfo.csv": f"{_TRUST_META}\n{ext_header}\n{ext_row}\n"}
        )
        records = mod.parse_codelist(data)
        assert len(records) == 1
        assert records[0].code == "7203"


class TestFetchCodelist:
    def test_saves_raw_with_license(self, tmp_path, monkeypatch):
        """fetch をモックし（内容は実フィクスチャのバイト列）保存経路を検証する。"""
        data = _zip_bytes()

        class _Resp:
            content = data

        monkeypatch.setattr(mod, "fetch", lambda url, **kw: _Resp())
        settings = load_settings(env={"RAW_DATA_DIR": str(tmp_path)}, dry_run=True)
        art = mod.fetch_codelist(settings)
        assert art.local_path.exists()
        assert art.local_path.read_bytes() == data  # 無加工保存 (§5.2)
        assert art.source is Source.EDINET
        assert art.datatype == "codelist"
        assert art.scope == "ALL"
        assert art.license_tag is LicenseTag.COMMERCIAL_OK
        assert art.url == mod.CODELIST_URL


class TestConvertCodelist:
    def _artifact(self, tmp_path):
        return save_raw(
            _zip_bytes(),
            source=Source.EDINET,
            datatype="codelist",
            scope="ALL",
            data_date=date(2026, 6, 10),
            url=mod.CODELIST_URL,
            ext="zip",
            license_tag=LicenseTag.COMMERCIAL_OK,
            base_dir=tmp_path,
        )

    def test_utf8_conversion_value_invariant(self, tmp_path):
        art = mod.convert_codelist(self._artifact(tmp_path))
        assert art.convert_status is ConvertStatus.DONE
        assert len(art.converted_paths) == 1
        out = art.converted_paths[0]
        assert out.name.endswith("_converted.csv")
        # 値不変 (§5.2): cp932→UTF-8 の文字コード正規化のみで内容は完全一致
        # （read_text は改行変換するため bytes で比較し、改行 \r\n も保持を確認）
        with zipfile.ZipFile(io.BytesIO(_zip_bytes())) as zf:
            original = zf.read("EdinetcodeDlInfo.csv").decode("cp932")
        assert out.read_bytes().decode("utf-8") == original

    def test_failure_records_status(self, tmp_path):
        art = self._artifact(tmp_path)
        art.local_path.write_bytes(b"not a zip")  # 破損原本でも例外にせず状態記録 (§8.1-3)
        art = mod.convert_codelist(art)
        assert art.convert_status is ConvertStatus.FAILED
        assert art.converted_paths == []
