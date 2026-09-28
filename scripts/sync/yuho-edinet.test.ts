/**
 * scripts/sync/yuho-edinet.ts (EDINET catchup トリガ) の transport テスト。
 *
 * #98: catchup ジョブが Worker への POST で落ちていた。実失敗は以下 2 種:
 *   - run36022119851: HeadersTimeoutError (応答遅延。~302 秒後に発火。
 *     undici 既定の headers 300 秒に対し Worker が全 catchup 後に応答するため)
 *   - run36156111106: read ECONNRESET (一過性切断。~249 秒後に発火)
 *
 * 修正方針: node:https による単発要求とし、ヘッダ＋本文全体に明示期限
 * (600 秒) をかける。再送・リダイレクト追従は一切しない — Worker 側に
 * 永続リース/要求冪等が無く (docId SELECT→取込・Notion key照会→作成は
 * 競合し得る。D1 書込が先なので D1 存在は Notion 完了を証明しない)、
 * 二重 POST は二重取込・二重保管を起こし得る。切断は可視のまま残し、
 * 運用 (次回定期実行の 60 日窓による自己回収・手動再実行) に委ねる。
 *
 * 本テストは実 TLS サーバ (127.0.0.1・自己署名・openssl 生成) に対する
 * transport チェックであり、要求回数が正確に 1 であることを数える。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as createHttpsServer, type Server } from "node:https";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { postCatchup } from "./yuho-edinet.js";

const SECRET = "test-secret-do-not-leak";
const PATH = "/yuho-quant/admin/catchup";

type Handler = (
  req: { url?: string },
  res: {
    writeHead: (code: number, headers?: Record<string, string>) => void;
    write: (s: string) => void;
    end: (s?: string) => void;
    destroy: () => void;
  }
) => void;

let server: Server;
let port = 0;
let certPem = "";
let requestCount = 0;
let handler: Handler = (_req, res) => res.end("default");
const sockets = new Set<Socket>();

const url = (): URL => new URL(`https://127.0.0.1:${port}${PATH}`);

function makeOpensslCnf(dir: string): string {
  const cnf = join(dir, "openssl.cnf");
  writeFileSync(
    cnf,
    [
      "[req]",
      "distinguished_name = dn",
      "x509_extensions = SAN",
      "prompt = no",
      "[dn]",
      "CN = localhost",
      "[SAN]",
      "subjectAltName = DNS:localhost,IP:127.0.0.1",
      "",
    ].join("\n")
  );
  return cnf;
}

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), "yuho-edinet-tls-"));
  const cnf = makeOpensslCnf(dir);
  const key = join(dir, "key.pem");
  const cert = join(dir, "cert.pem");
  const r = spawnSync(
    "openssl",
    [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", key, "-out", cert,
      "-days", "2", "-nodes",
      "-config", cnf, "-extensions", "SAN",
    ],
    { encoding: "utf-8" }
  );
  if (r.status !== 0) {
    throw new Error(
      `テスト用 TLS 証明書の生成に openssl が必要です: ${(r.stderr || "").slice(0, 300)}`
    );
  }
  certPem = readFileSync(cert, "utf-8");
  server = createHttpsServer(
    { key: readFileSync(key), cert: readFileSync(cert) },
    (req, res) => {
      requestCount++;
      handler(req, res);
    }
  );
  server.on("connection", (s: Socket) => {
    sockets.add(s);
    s.on("error", () => {});
    s.on("close", () => sockets.delete(s));
  });
  return new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as { port: number }).port;
      resolve();
    });
  });
});

afterAll(async () => {
  for (const s of sockets) s.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function catchError(p: Promise<string>): Promise<Error> {
  return (await p.catch((e: unknown) => e)) as Error;
}

describe("postCatchup transport (#98)", () => {
  it("期限内の遅延応答に成功し、要求は1回だけ送る", async () => {
    requestCount = 0;
    handler = (_req, res) => {
      setTimeout(() => res.end("done-body"), 300);
    };
    await expect(
      postCatchup(url(), SECRET, { timeoutMs: 10_000, tlsCaPem: certPem })
    ).resolves.toBe("done-body");
    expect(requestCount).toBe(1);
  });

  it("期限切れで失敗し、再送しない (切断は可視のまま)", async () => {
    requestCount = 0;
    handler = () => {
      // 応答しない (期限切れを起こす)。
    };
    const err = await catchError(postCatchup(
      url(),
      SECRET,
      { timeoutMs: 300, tlsCaPem: certPem }
    ));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/期限切れ/);
    expect(requestCount).toBe(1);
  });

  it("途中で切れた応答で失敗し、再送しない", async () => {
    requestCount = 0;
    handler = (_req, res) => {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.write("partial");
      res.destroy();
    };
    const err = await catchError(postCatchup(
      url(),
      SECRET,
      { timeoutMs: 10_000, tlsCaPem: certPem }
    ));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toMatch(/中断|切断|エラー/);
    expect(requestCount).toBe(1);
  });

  it("HTTP 500 は status のみで失敗し、再送しない (本文は載せない)", async () => {
    requestCount = 0;
    handler = (_req, res) => {
      res.writeHead(500, { "Content-Type": "text/plain" });
      // 上流応答は untrusted: 秘密・URL が混ざっても文に出さない。
      res.end(`boom ${SECRET} https://127.0.0.1:${port}/secret-path?token=abc`);
    };
    const err = await catchError(postCatchup(
      url(),
      SECRET,
      { timeoutMs: 10_000, tlsCaPem: certPem }
    ));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("catchup 失敗: HTTP 500");
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain("127.0.0.1");
    expect(requestCount).toBe(1);
  });

  it("エラー文・cause に秘密・URL を含めない", async () => {
    handler = () => {
      // 応答しない (期限切れを起こす)。
    };
    const err = await catchError(postCatchup(
      url(),
      SECRET,
      { timeoutMs: 300, tlsCaPem: certPem }
    ));
    expect(err.message).not.toContain(SECRET);
    expect(err.message).not.toContain("127.0.0.1");
    expect(err.message).not.toContain(PATH);
    // cause を付けないことが漏洩防止の機構 (https 層の元エラーは
    // ホスト名を埋め込むことがあるためそのまま残さない)。
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });

  it("https 以外は要求を送らず即失敗する", async () => {
    requestCount = 0;
    const httpUrl = new URL(`http://127.0.0.1:${port}${PATH}`);
    await expect(postCatchup(httpUrl, SECRET)).rejects.toThrow(/https のみ/);
    expect(requestCount).toBe(0);
  });
});
