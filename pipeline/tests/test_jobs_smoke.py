"""ジョブ層のスモークテスト (§10: dry-run 必須 / §8.1-4: 原本必須の保証)。

- 全て dry-run + 実フィクスチャで実行 (Notion へは一切書き込まない §3-6)
- コレクターの fetch 系のみ実フィクスチャのバイト列を返す関数へ差し替える
- 検証点:
  (a) 例外なく完走し終了コードが正しい
  (b) 構造化データ書き込みより前に原本 (⑤) 系の操作が記録される
  (c) RawUploadError 時に構造化 upsert が一切記録されない (§8.1-4)
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path

import pytest

from conftest import fixture_path

from jp_stock_pipeline.collectors import (
    edinet,
    edinet_codelist,
    tdnet_yanoshin,
)
from jp_stock_pipeline.jobs import (
    edinet_daily,
    master_sync,
    runner,
    tdnet_hourly,
)
from jp_stock_pipeline.licensing import LicenseTag, source_license
from jp_stock_pipeline.models import JST, Source
from jp_stock_pipeline.notion import file_upload
from jp_stock_pipeline.notion import schema as S
from jp_stock_pipeline.notion.client import NotionClient
from jp_stock_pipeline.rawstore import save_raw


@pytest.fixture
def captured_clients(monkeypatch) -> list[NotionClient]:
    """run_job 内で生成される NotionClient を捕捉する (ops 検証用)。"""
    created: list[NotionClient] = []

    def factory(token, *, rps, dry_run):
        client = NotionClient(token, rps=1000.0, dry_run=dry_run)
        created.append(client)
        return client

    monkeypatch.setattr(runner, "NotionClient", factory)
    return created


def _env(tmp_path: Path) -> dict[str, str]:
    return {"RAW_DATA_DIR": str(tmp_path / "raw")}


def _ops_with_prop(client: NotionClient, prop_name: str) -> list:
    return [
        op for op in client.ops
        if prop_name in (op.payload.get("properties") or {})
    ]


class TestMasterSync:
    def _patch_fetch(self, monkeypatch, tmp_path):
        zip_bytes = fixture_path("edinet/Edinetcode.zip").read_bytes()

        def fake_fetch(settings):
            return save_raw(
                zip_bytes,
                source=Source.EDINET,
                datatype="codelist",
                scope="ALL",
                data_date=date(2026, 6, 10),
                url="fixture://edinet/Edinetcode.zip",
                ext="zip",
                license_tag=source_license(Source.EDINET),
                base_dir=settings.raw_data_dir,
            )

        monkeypatch.setattr(edinet_codelist, "fetch_codelist", fake_fetch)

    def test_dry_run_completes_and_raw_before_upserts(
        self, monkeypatch, tmp_path, captured_clients
    ):
        self._patch_fetch(monkeypatch, tmp_path)
        code = master_sync.main(["--dry-run", "--limit", "5"], env=_env(tmp_path))
        assert code == 0

        client = captured_clients[0]
        assert client.dry_run
        # (b) 原本 (SHA256 プロパティを持つ ⑤ 行) が ① (銘柄名) より先に記録される
        ops = client.ops
        raw_idx = next(
            i for i, op in enumerate(ops)
            if S.RAW_PROP_SHA256 in (op.payload.get("properties") or {})
        )
        master_idx = next(
            i for i, op in enumerate(ops)
            if S.MASTER_PROP_NAME in (op.payload.get("properties") or {})
        )
        assert raw_idx < master_idx
        # --limit 5 で ① の書き込みは5件
        assert len(_ops_with_prop(client, S.MASTER_PROP_NAME)) == 5
        # 全 ① 行にライセンスタグ commercial-ok が付与される (§6.3, §2.1)
        for op in _ops_with_prop(client, S.MASTER_PROP_NAME):
            tag = op.payload["properties"][S.PROP_LICENSE_TAG]["select"]["name"]
            assert tag == LicenseTag.COMMERCIAL_OK.value

    def test_prefetch_map_eliminates_per_record_queries(
        self, monkeypatch, tmp_path, captured_clients
    ):
        """① マップ一括取得で per-record 検索を排除する (§8.3 ops削減=60分timeout対策)。

        従来は 1銘柄あたり _find_page(query) + create/update の2callだった。マップを
        先頭で1回ロードし page_resolved=True で渡すことで query は「マップ取得1回」のみ
        に減る（per-record 検索ゼロ）ことを query 呼び出し回数で保証する。
        """
        from jp_stock_pipeline.notion.client import NotionClient

        self._patch_fetch(monkeypatch, tmp_path)
        calls = {"n": 0}

        def counting_query(self, db_id, **kwargs):
            calls["n"] += 1
            return []  # 空 ① = 全件 create 経路

        monkeypatch.setattr(NotionClient, "query_database", counting_query)
        code = master_sync.main(["--dry-run", "--limit", "5"], env=_env(tmp_path))
        assert code == 0
        client = captured_clients[0]
        assert len(_ops_with_prop(client, S.MASTER_PROP_NAME)) == 5  # ① 5件
        # query は固定2回のみ = ⑤原本SHA256重複チェック1回 + ①マップ一括取得1回。
        # per-record 検索(本来は銘柄数=5回)はゼロ。レコード数に比例しないのが要点
        # (従来は 1[⑤] + 5[per-record] = 6 だった)。
        assert calls["n"] == 2

    def test_dedup_by_code_keeps_last_occurrence(self):
        """同一コードの重複は最後を採用（事前マップ運用での二重 create を防ぐ）。"""
        from jp_stock_pipeline.jobs.master_sync import _dedup_by_code

        class _R:
            def __init__(self, code, name):
                self.code = code
                self.name = name

        out = _dedup_by_code([_R("7203", "a"), _R("6758", "b"), _R("7203", "c")])
        assert [r.code for r in out] == ["7203", "6758"]  # 初出順を維持
        assert {r.code: r.name for r in out}["7203"] == "c"  # 値は最後の出現

    def test_raw_upload_failure_aborts_structured_writes(
        self, monkeypatch, tmp_path, captured_clients
    ):
        """(c) §8.1-4: 原本UL失敗 → 構造化データを書かず異常終了。"""
        self._patch_fetch(monkeypatch, tmp_path)

        def boom(client, settings, artifact, **kw):
            raise file_upload.RawUploadError("テスト: アップロード失敗")

        monkeypatch.setattr(file_upload, "upload_raw_artifact", boom)
        code = master_sync.main(["--dry-run", "--limit", "5"], env=_env(tmp_path))
        assert code == 1  # 失敗

        client = captured_clients[0]
        assert _ops_with_prop(client, S.MASTER_PROP_NAME) == []  # ① への書き込みなし
        # 失敗終了する（実行履歴は D1 jss_job_runs。Notion ⑦ は廃止）

    def test_delisting_detection_marks_absent(self, monkeypatch, tmp_path, captured_clients):
        """コードリストから消えた銘柄を listed=False にする (§ Phase3)。
        状態=上場廃止 の確定は一次開示に一本化し、消失検知では状態を倒さない。"""
        from jp_stock_pipeline.licensing import LicenseTag
        from jp_stock_pipeline.models import Provenance, StockMasterRecord, now_jst
        from jp_stock_pipeline.notion.client import NotionClient

        self._patch_fetch(monkeypatch, tmp_path)
        # コードリストの現役は 7203 のみ
        rec = StockMasterRecord(
            code="7203", name="トヨタ自動車", listed=True, status="上場",
            provenance=Provenance(
                source=Source.EDINET, license_tag=LicenseTag.COMMERCIAL_OK,
                data_date=date(2026, 6, 10), fetched_at=now_jst(),
            ),
        )
        monkeypatch.setattr(edinet_codelist, "parse_codelist", lambda *a, **k: [rec])
        # ① には 7203 と 9999(コードリストから消えた) が既存
        def fake_query(self, db_id, **kwargs):
            return [
                {"id": "p-7203",
                 "properties": {S.MASTER_PROP_CODE: {"rich_text": [{"plain_text": "7203"}]}}},
                {"id": "p-9999",
                 "properties": {S.MASTER_PROP_CODE: {"rich_text": [{"plain_text": "9999"}]}}},
            ]
        monkeypatch.setattr(NotionClient, "query_database", fake_query)

        code = master_sync.main(["--dry-run"], env=_env(tmp_path))  # --limit 無し=全件
        assert code == 0
        client = captured_clients[0]
        delisted = [
            o for o in client.ops
            if o.op == "update_page" and o.payload["page_id"] == "p-9999"
        ]
        assert len(delisted) == 1
        props = delisted[0].payload["properties"]
        assert props[S.MASTER_PROP_LISTED]["checkbox"] is False
        # 消失検知は listed=False のみ。状態=上場廃止 は一次開示由来に一本化 (§3-1/§3-7)
        assert S.MASTER_PROP_STATUS not in props

    def test_blast_radius_guard_blocks_mass_delisting(
        self, monkeypatch, tmp_path, captured_clients, caplog
    ):
        """コードリストが既存の50%未満なら一括上場廃止せず中止する (§ Phase3 安全弁)。"""
        from jp_stock_pipeline.licensing import LicenseTag
        from jp_stock_pipeline.models import Provenance, StockMasterRecord, now_jst
        from jp_stock_pipeline.notion.client import NotionClient

        self._patch_fetch(monkeypatch, tmp_path)
        # 取得は 1 銘柄のみ（異常取得を模す）
        rec = StockMasterRecord(
            code="7203", name="トヨタ自動車", listed=True,
            provenance=Provenance(
                source=Source.EDINET, license_tag=LicenseTag.COMMERCIAL_OK,
                data_date=date(2026, 6, 10), fetched_at=now_jst(),
            ),
        )
        monkeypatch.setattr(edinet_codelist, "parse_codelist", lambda *a, **k: [rec])
        # ① には 4 銘柄が既存 → 取得1件は 50%(=2)未満なので安全弁が作動
        def fake_query(self, db_id, **kwargs):
            return [
                {"id": f"p-{c}",
                 "properties": {S.MASTER_PROP_CODE: {"rich_text": [{"plain_text": c}]}}}
                for c in ("7203", "9001", "9002", "9003")
            ]
        monkeypatch.setattr(NotionClient, "query_database", fake_query)

        code = master_sync.main(["--dry-run"], env=_env(tmp_path))
        client = captured_clients[0]
        # 上場廃止マーク (listed=False) が一切発行されない
        mass_delist = [
            o for o in client.ops
            if o.op == "update_page"
            and o.payload["properties"].get(S.MASTER_PROP_LISTED) == {"checkbox": False}
        ]
        assert mass_delist == []
        # 中止を警告ログに出す（黙って中止せず可視化 §3-2。履歴は D1 jss_job_runs）
        assert "上場廃止検知を中止" in caplog.text
        assert code == 0  # processed>0 & failed>0 = 一部失敗は exit 0


class TestTdnetHourly:
    def test_dry_run_with_fixture(self, monkeypatch, tmp_path, captured_clients):
        payload_bytes = fixture_path("tdnet/yanoshin_list_recent.json").read_bytes()
        payload = json.loads(payload_bytes)

        def fake_list(settings, target="recent", limit=300):
            artifact = save_raw(
                payload_bytes,
                source=Source.TDNET,
                datatype="tdnet_list",
                scope=str(target),
                data_date=date(2026, 6, 10),
                url="fixture://tdnet/recent",
                ext="json",
                license_tag=source_license(Source.TDNET),
                base_dir=settings.raw_data_dir,
            )
            records = tdnet_yanoshin.parse_list_payload(
                payload, fetched_at=artifact.fetched_at
            )
            return artifact, records

        monkeypatch.setattr(tdnet_yanoshin, "list_disclosures", fake_list)
        # XBRL 取得はネットワークのため遮断 (失敗経路 = 欠損として記録 §3-2)
        from jp_stock_pipeline.http import FetchError

        def no_network(url, **kwargs):
            raise FetchError(f"テスト: ネットワーク遮断 {url}")

        monkeypatch.setattr(tdnet_hourly, "fetch", no_network)

        code = tdnet_hourly.main(["--dry-run"], env=_env(tmp_path))
        assert code == 0  # ④ は成立する (XBRL→③ の失敗があっても一部失敗まで)

        client = captured_clients[0]
        disc_ops = _ops_with_prop(client, S.DISC_PROP_DOC_ID)
        assert len(disc_ops) > 0
        # ④ のライセンスタグは factual-cite (§2.1)
        for op in disc_ops:
            tag = op.payload["properties"][S.PROP_LICENSE_TAG]["select"]["name"]
            assert tag == LicenseTag.FACTUAL_CITE.value

    def test_prefetch_maps_make_queries_constant_not_per_disclosure(
        self, monkeypatch, tmp_path, captured_clients
    ):
        """①/④ 事前マップで Notion query が開示件数に比例しない (§8.3 30分cap対策)。

        従来は開示ごとに ① find + ④ dedup の 2 query。事前マップ化で query は
        「① マップ + ④ マップ + ⑤原本SHA256重複(原本数)」のみ＝開示件数に非比例。
        """
        from jp_stock_pipeline.collectors import tdnet_yanoshin
        from jp_stock_pipeline.http import FetchError
        from jp_stock_pipeline.notion.client import NotionClient

        payload_bytes = fixture_path("tdnet/yanoshin_list_recent.json").read_bytes()
        payload = json.loads(payload_bytes)

        def fake_list(settings, target="recent", limit=300):
            artifact = save_raw(
                payload_bytes, source=Source.TDNET, datatype="tdnet_list",
                scope=str(target), data_date=date(2026, 6, 10),
                url="fixture://tdnet/recent", ext="json",
                license_tag=source_license(Source.TDNET), base_dir=settings.raw_data_dir,
            )
            records = tdnet_yanoshin.parse_list_payload(payload, fetched_at=artifact.fetched_at)
            return artifact, records

        monkeypatch.setattr(tdnet_yanoshin, "list_disclosures", fake_list)
        monkeypatch.setattr(tdnet_hourly, "fetch", lambda url, **k: (_ for _ in ()).throw(
            FetchError("net cut")))

        per_db_queries: dict[str, int] = {}

        def counting_query(self, db_id, **kwargs):
            per_db_queries[str(db_id)] = per_db_queries.get(str(db_id), 0) + 1
            return []  # 空 = 全 create 経路

        monkeypatch.setattr(NotionClient, "query_database", counting_query)
        # フィクスチャ開示は全て 2026-06-10。--date を一致させ全件 in-window にすることで
        # ④ date-scoped マップが信用され per-record 検索が消える（日付不一致時は安全側で
        # per-record 検索にフォールバックするのが正しい挙動）。
        code = tdnet_hourly.main(["--dry-run", "--date", "2026-06-10"], env=_env(tmp_path))
        assert code == 0
        client = captured_clients[0]
        n_disc = len(_ops_with_prop(client, S.DISC_PROP_DOC_ID))
        assert n_disc > 1  # 複数開示があることを前提に「非比例」を意味あるものにする
        # どの DB も query は最大1回（① マップ/④ マップ/⑤原本SHA256 各1回）。per-record
        # 検索が残っていれば db-disc や db-master が n_disc 回に膨らむ。最大1で非比例を保証。
        # 従来は開示ごとに ① find + ④ dedup = 2×n_disc query だった。
        assert per_db_queries  # 何らかの query はある（マップロード）
        assert max(per_db_queries.values()) == 1


class TestEdinetDailyTargetDate:
    """対象日は「起動時刻の JST 日付」ではなく cron の予定日に一致する。

    2026-08-27〜09-10 に、GitHub Actions のスケジュール遅延 (実測 +3.5h〜+9.5h) で
    起動が翌日 JST へずれ、まだ提出 0 件の「翌日」の一覧を 11 営業日連続で取得して
    processed=0 / failed=0 の「成功」を出し続けた。その再発防止。
    """

    @pytest.mark.parametrize(
        ("started", "expected"),
        [
            # 定刻 (12:00Z = 21:00 JST) 起動 → 当日が対象
            (datetime(2026, 9, 10, 21, 0, tzinfo=JST), date(2026, 9, 10)),
            # 実測 run 34496419755: 2026-09-10T15:33Z = 09-11 00:33 JST → 対象は 09-10
            (datetime(2026, 9, 11, 0, 33, tzinfo=JST), date(2026, 9, 10)),
            # 実測 run 33118324540: 2026-08-27T21:28Z = 08-28 06:28 JST → 対象は 08-27
            (datetime(2026, 8, 28, 6, 28, tzinfo=JST), date(2026, 8, 27)),
            # 予定時刻の直前 (遅延 24h 手前) までは前日へ吸収される
            (datetime(2026, 9, 11, 20, 59, tzinfo=JST), date(2026, 9, 10)),
        ],
    )
    def test_default_target_date_follows_schedule_not_start_time(self, started, expected):
        assert edinet_daily.default_target_date(started) == expected

    def test_empty_document_list_is_recorded_as_failure(
        self, monkeypatch, tmp_path
    ):
        """一覧 0 件を「成功」で黙って終えない (§3-2 欠損を隠さない)。

        取得単位が 1 件も成立していないので runner の規則どおり「失敗」= 終了コード 1。
        国民の祝日は EDINET 提出が 0 件のため、この経路で毎回赤くなるのは想定内で、
        エラー通知が未実装の現状ではこれが唯一の生存確認を兼ねる (README に明記)。
        実行履歴は D1 jss_job_runs に残る（Notion ⑦ は廃止）。
        """
        payload = b'{"metadata": {"status": "200"}, "results": []}'

        def fake_list(settings, target_date):
            artifact = save_raw(
                payload,
                source=Source.EDINET,
                datatype="documents_list",
                scope="ALL",
                data_date=target_date,
                url="fixture://edinet/empty",
                ext="json",
                license_tag=source_license(Source.EDINET),
                base_dir=settings.raw_data_dir,
            )
            return artifact, []

        monkeypatch.setattr(edinet, "list_documents", fake_list)
        code = edinet_daily.main(
            ["--dry-run", "--date", "2026-09-10"], env=_env(tmp_path)
        )
        assert code == 1  # 黙って success で終わらない（11営業日の無言欠測の再発防止）


REPO_ROOT = Path(__file__).resolve().parents[2]


def _workflow_text(name: str) -> str:
    """`.github/workflows/<name>.yml` の本文を読む。

    移設の過渡期はファイルが未移設のため skip する（PR-2 で ci.yml に
    python-pipeline ジョブ、PR-3 で 5 cron + cloud_check を移設する）。
    ファイルが現れれば自動で検証が有効になる。
    """
    path = REPO_ROOT / ".github" / "workflows" / f"{name}.yml"
    if not path.exists():
        pytest.skip(f"{name}.yml は未移設（PR-2/PR-3 で移設予定）")
    return path.read_text(encoding="utf-8")


class TestWorkflowCrons:
    """§8.2 スケジュール (JST) と cron (UTC) の対応検証。"""

    EXPECTED = {
        "master_sync": "0 21 1 * *",
        "tdnet_hourly": "0 0-10 * * 1-5",
        "edinet_daily": "0 12 * * 1-5",
        "supply_daily": "17 3 * * 1-5",
    }

    @pytest.mark.parametrize("name", sorted(EXPECTED))
    def test_cron(self, name):
        text = _workflow_text(name)
        # コメント行（`# 元: cron: "..."` の Wave 5 申送り）を除いて探す。
        # コメントに反応すると「cron 未装着なのに緑」になる。
        live = "\n".join(
            line for line in text.splitlines() if not line.strip().startswith("#")
        )
        m = re.search(r'cron:\s*"([^"]+)"', live)
        assert m, f"{name}.yml に live の cron が無い"
        assert m.group(1) == self.EXPECTED[name]
        assert "workflow_dispatch" in text  # 手動実行可
        assert f"jp_stock_pipeline.jobs.{name}" in text

    def test_ci_runs_pytest(self):
        text = _workflow_text("ci")
        assert "pytest" in text
        assert "nix develop" in text


class TestOpsCheckIssueLifecycle:
    """ops_check.yml は赤で SLO 違反 Issue を立て、4 層すべて緑で閉じる。

    閉じる条件に層の outcome を 1 つでも書き忘れると、その層を見ないまま Issue を
    閉じる。層を足したときの書き忘れを、`id:` の一覧との突き合わせで捕まえる。
    pyyaml は直接依存ではないので、周囲のテストと同じく本文を文字列で読む。
    """

    CLOSE_STEP = "- name: SLO が緑に戻ったら SLO 違反 Issue を閉じる"

    def _text(self) -> str:
        return _workflow_text("ops_check")

    def _close_block(self, text: str) -> str:
        assert self.CLOSE_STEP in text, "緑で Issue を閉じるステップが無い"
        block = text.split(self.CLOSE_STEP, 1)[1]
        # 次のステップ（あれば）の手前まで
        return re.split(r"\n\s*- name:", block, maxsplit=1)[0]

    def test_close_requires_every_layer_success(self):
        text = self._text()
        ids = re.findall(r"^\s*id:\s*(\w+)\s*$", text, re.MULTILINE)
        assert set(ids) == {"probe", "judge", "drift", "license"}
        cond = self._close_block(text).split("env:", 1)[0]
        assert "success()" in cond
        for step_id in ids:
            assert f"steps.{step_id}.outcome == 'success'" in cond, step_id
        # 各項が揃っていても `||` で繋ぐと 1 層だけ緑で閉じる。`always()` は
        # キャンセル時にも走る。どちらも上の包含チェックだけでは素通りする。
        assert "||" not in cond
        assert "always()" not in cond

    def test_title_is_shared_and_matched_exactly(self):
        text = self._text()
        # 立てる側と閉じる側が別々に文字列を持つと、片方だけ書き換わって黙る
        assert text.count("[SLO違反] データの鮮度またはジョブ結果") == 1
        assert "SLO_ISSUE_TITLE:" in text
        close = self._close_block(text)
        assert "select(.title == env.SLO_ISSUE_TITLE)" in close
        assert "--search" not in close  # 部分一致は無関係な Issue を閉じ得る
        assert "gh issue close" in close
        create = text.split("- name: SLO 違反を Issue に出す", 1)[1].split(
            self.CLOSE_STEP, 1
        )[0]
        assert "select(.title == env.SLO_ISSUE_TITLE)" in create
        assert '--title "$SLO_ISSUE_TITLE"' in create


class TestEdinetLargeHolding:
    """大量保有報告書 (350/360) の取りこぼし修正。

    350/360 は**保有者が提出する**ため secCode が入らない。実データ（直近12日分の
    一覧）で 350 が 992 件中 956 件、360 が 412 件中 405 件で secCode が空だった。
    secCode だけで絞っていたため 96〜98% を取りこぼしていた。
    対象会社は issuerEdinetCode（実測 956/956 = 100% 充足）から解決する。
    """

    # 実レスポンスから採った 1 件（docID/コードは実値、氏名は構造確認のため保持）
    REAL_350 = {
        "docID": "S100Y8QP",
        "secCode": None,
        "edinetCode": "E41686",
        "issuerEdinetCode": "E04369",
        "subjectEdinetCode": None,
        "docTypeCode": "350",
        "docDescription": "変更報告書（特例対象株券等）",
        "submitDateTime": "2026-09-10 15:30",
    }
    REAL_120 = {
        "docID": "S100ABCD",
        "secCode": "72030",
        "issuerEdinetCode": None,
        "docTypeCode": "120",
        "submitDateTime": "2026-09-10 15:30",
    }

    def test_large_holding_without_seccode_is_now_collected(self):
        from jp_stock_pipeline.collectors import edinet

        assert edinet.has_sec_code(self.REAL_350) is False  # 従来はここで落ちていた
        assert edinet.is_target_document(self.REAL_350) is True
        assert edinet.has_identifiable_company(self.REAL_350) is True

    def test_issuer_edinet_code_is_extracted(self):
        from jp_stock_pipeline.collectors import edinet

        assert edinet.issuer_edinet_code(self.REAL_350) == "E04369"
        assert edinet.issuer_edinet_code(self.REAL_120) is None

    def test_ordinary_document_still_uses_seccode(self):
        from jp_stock_pipeline.collectors import edinet

        assert edinet.has_identifiable_company(self.REAL_120) is True

    def test_non_large_holding_without_seccode_is_still_excluded(self):
        """secCode も issuerEdinetCode も無い書類は対象外のまま。"""
        from jp_stock_pipeline.collectors import edinet

        doc = {"docID": "X", "docTypeCode": "120", "secCode": None}
        assert edinet.has_identifiable_company(doc) is False

    def test_issuer_code_is_not_used_for_non_large_holding(self):
        """有報に issuerEdinetCode があっても secCode の代わりにはしない。"""
        from jp_stock_pipeline.collectors import edinet

        doc = {"docID": "X", "docTypeCode": "120", "secCode": None,
               "issuerEdinetCode": "E04369"}
        assert edinet.has_identifiable_company(doc) is False

    def test_edinet_map_is_built_from_the_same_master_scan(self):
        """① の1回のスキャンから逆引きを作る（追加の API 呼び出しをしない）。"""
        from jp_stock_pipeline.notion import upsert

        pages = [{
            "id": "page-7203",
            "properties": {
                S.MASTER_PROP_CODE: {"rich_text": [{"plain_text": "7203"}]},
                S.MASTER_PROP_EDINET_CODE: {"rich_text": [{"plain_text": "E04369"}]},
            },
        }]
        assert upsert._master_map_from_pages(pages) == {"7203": "page-7203"}
        assert upsert._edinet_map_from_pages(pages) == {"E04369": "7203"}

    def test_master_page_without_edinet_code_is_skipped(self):
        from jp_stock_pipeline.notion import upsert

        pages = [{
            "id": "p",
            "properties": {S.MASTER_PROP_CODE: {"rich_text": [{"plain_text": "7203"}]}},
        }]
        assert upsert._edinet_map_from_pages(pages) == {}


class TestFinancialCustody:
    """財務系の実解析原本は Notion ⑤ 物理保管が構造化保存の前提条件。

    共有 `upload_raw` の既定（双方向フェールセーフ）は他ジョブ用に維持し、
    財務系だけ `require_notion=True` で local-only NULL 成功を STOP する。
    """

    def _ctx(self, tmp_path, *, local_ok=True):
        from types import SimpleNamespace

        from jp_stock_pipeline.config import load_settings
        from jp_stock_pipeline.jobs.runner import JobContext

        settings = load_settings(dry_run=True, env=_env(tmp_path))
        local = SimpleNamespace(
            upsert_raw_artifact=lambda artifact: (
                None if local_ok else (_ for _ in ()).throw(RuntimeError("テスト: ローカル失敗"))
            )
        )
        return JobContext(settings=settings, client=None, args=None, local=local)

    def _artifact(self, tmp_path):
        settings_dir = tmp_path / "raw"
        return save_raw(
            fixture_path("edinet/Edinetcode.zip").read_bytes(),
            source=Source.EDINET,
            datatype="csv",
            scope="7203",
            data_date=date(2026, 6, 10),
            url="fixture://edinet/Edinetcode.zip",
            ext="zip",
            license_tag=source_license(Source.EDINET),
            base_dir=settings_dir,
        )

    def test_require_notion_failure_stops_despite_local_ok(self, monkeypatch, tmp_path):
        """require_notion: Notion 失敗 + ローカル成功 → 中止 (NULL 成功にしない)。"""
        ctx = self._ctx(tmp_path, local_ok=True)

        def boom(client, settings, artifact, **kw):
            raise file_upload.RawUploadError("テスト: Notion 失敗")

        monkeypatch.setattr(file_upload, "upload_raw_artifact", boom)
        with pytest.raises(file_upload.RawUploadError, match="require_notion"):
            ctx.upload_raw(self._artifact(tmp_path), require_notion=True)

    def test_require_notion_dup_skip_resumes_without_upload(self, monkeypatch, tmp_path):
        """require_notion: 既存 SHA は再送せず既存 page_id (中断後の再開)。"""
        ctx = self._ctx(tmp_path, local_ok=True)
        monkeypatch.setattr(file_upload, "find_raw_page_by_sha256", lambda *a, **k: "page-exists")

        def must_not_send(client, path):
            raise AssertionError("再送してはならない")

        monkeypatch.setattr(file_upload, "upload_file", must_not_send)
        assert ctx.upload_raw(self._artifact(tmp_path), require_notion=True) == "page-exists"

    def test_require_notion_success_returns_page_id(self, monkeypatch, tmp_path):
        """require_notion: Notion 成功 → page_id を返す (通常経路)。"""
        ctx = self._ctx(tmp_path, local_ok=True)
        monkeypatch.setattr(
            file_upload,
            "upload_raw_artifact",
            lambda client, settings, artifact, **kw: "page-new",
        )
        assert ctx.upload_raw(self._artifact(tmp_path), require_notion=True) == "page-new"

    def test_default_preserves_failsafe_none_on_notion_failure(self, monkeypatch, tmp_path):
        """既定: Notion 失敗 + ローカル成功 → None を返し続行 (他ジョブ不変)。"""
        ctx = self._ctx(tmp_path, local_ok=True)

        def boom(client, settings, artifact, **kw):
            raise file_upload.RawUploadError("テスト: Notion 失敗")

        monkeypatch.setattr(file_upload, "upload_raw_artifact", boom)
        assert ctx.upload_raw(self._artifact(tmp_path)) is None

    def test_financial_tidy_custody_failure_aborts_document_unit(self, monkeypatch, tmp_path):
        """財務系: tidy 原本の Notion 保管失敗 → 書類単位を中止 (③④を書かない)。"""
        from jp_stock_pipeline.jobs.runner import JobContext

        ctx = self._ctx(tmp_path, local_ok=True)
        persisted: list = []
        monkeypatch.setattr(
            JobContext,
            "persist",
            lambda self, record, notion_write, **kw: persisted.append(record) or True,
        )

        def strict_boom(artifact, **kw):
            assert kw.get("require_notion") is True  # 財務系は strict 呼び出し
            raise file_upload.RawUploadError("テスト: tidy 保管失敗")

        monkeypatch.setattr(ctx, "upload_raw", strict_boom)
        monkeypatch.setattr(
            edinet_daily,
            "_fetch_financial_tidy",
            lambda ctx_, doc_id, code, data_date: (self._artifact(tmp_path), None),
        )
        doc = dict(TestEdinetLargeHolding.REAL_120)
        with pytest.raises(file_upload.RawUploadError):
            edinet_daily._process_document(
                ctx,
                doc,
                "list-page",
                master_map={},
                master_map_ok=False,
                edinet_map={},
                disc_map={},
                disc_map_ok=False,
                target_date=date(2026, 9, 10),
                sha_map=None,
            )
        assert persisted == []  # ④③ ともに書かない

    def test_financial_guard_rejects_list_substitution(self, monkeypatch, tmp_path):
        """財務系: 実解析原本ページ無しで一覧/PDF 代替 → 中止 (不変条件)。"""
        from jp_stock_pipeline.collectors import edinet
        from jp_stock_pipeline.http import FetchError
        from jp_stock_pipeline.jobs.runner import JobContext

        ctx = self._ctx(tmp_path, local_ok=True)
        persisted: list = []
        monkeypatch.setattr(
            JobContext,
            "persist",
            lambda self, record, notion_write, **kw: persisted.append(record) or True,
        )
        # legacy 経路の再現: strict 無し相当で None が返る + PDF も取れない
        monkeypatch.setattr(ctx, "upload_raw", lambda artifact, **kw: None)
        monkeypatch.setattr(
            edinet_daily,
            "_fetch_financial_tidy",
            lambda ctx_, doc_id, code, data_date: (self._artifact(tmp_path), None),
        )
        monkeypatch.setattr(
            edinet,
            "fetch_document",
            lambda *a, **k: (_ for _ in ()).throw(FetchError("テスト: PDF 失敗")),
        )
        doc = dict(TestEdinetLargeHolding.REAL_120)
        with pytest.raises(file_upload.RawUploadError, match="一覧/PDF代替不可"):
            edinet_daily._process_document(
                ctx,
                doc,
                "list-page",
                master_map={},
                master_map_ok=False,
                edinet_map={},
                disc_map={},
                disc_map_ok=False,
                target_date=date(2026, 9, 10),
                sha_map=None,
            )
        assert persisted == []


class TestWorkflowManualDate:
    """手動実行の --date が子 bash へ位置引数で届く (親配列の黙殺防止)。

    `nix develop -c bash -c '... "${args[@]}"'` は単一引用符内のため親配列が
    展開されず、内側 bash の未定義配列として黙って落ちていた。`"$@"` +
    `_ "${args[@]}"` の位置渡しに統一する。
    """

    @pytest.mark.parametrize("name", ["edinet_daily", "tdnet_hourly"])
    def test_manual_date_forwarded_positionally(self, name):
        live = "\n".join(
            line for line in _workflow_text(name).splitlines() if not line.strip().startswith("#")
        )
        m = re.search(r"bash -c '[^']*\"\$\@\"[^']*' _ \"\$\{args\[@\]\}\"", live)
        assert m, f'{name}.yml: "$@" 位置渡しが無い (手動 --date が黙殺される)'
        assert '"${args[@]}"\'' not in live  # 旧: 単一引用符内の未展開

    def test_date_option_parses_yyyymmdd(self):
        parser = runner.build_parser("test")
        assert parser.parse_args(["--date", "2026-01-05"]).date == date(2026, 1, 5)
        with pytest.raises(SystemExit):
            parser.parse_args(["--date", "2026/01/05"])
