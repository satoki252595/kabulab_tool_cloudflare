import { vi } from "vitest";
import { main } from "./main.js";

// installerの通常入口を実行し、OS側の作成・構文検証だけを捕捉する。launchdや.envには触れない。
const io = vi.hoisted(() => ({
  write: vi.fn(), mkdir: vi.fn(), spawn: vi.fn(), preflight: vi.fn(() => ({
    revision: "4141ca8c66b666a3972232b1581488cf5a35a661", state: "/tmp/biztag-install-test/biztag-local",
  })),
  exec: vi.fn((command: string) => {
    if (command === "which") return "/nix/var/nix/profiles/default/bin/nix\n";
    if (command === "plutil") return "";
    throw new Error(`installerの想定外command: ${command}`);
  }),
}));
vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>(),
  existsSync: () => false, mkdirSync: io.mkdir, writeFileSync: io.write,
}));
vi.mock("node:child_process", async (original) => ({ ...await original<typeof import("node:child_process")>(),
  execFileSync: io.exec, spawn: io.spawn,
}));
vi.mock("node:os", async (original) => ({ ...await original<typeof import("node:os")>(), homedir: () => "/tmp/biztag-install-test" }));
vi.mock("./runtime.js", () => ({ preflight: io.preflight }));

it("install-nextは同じ通常installerでRunAtLoadだけfalseにし、20/21時calendarと既installを保つ", async () => {
  const log = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    for (const kind of [undefined, "biztag", "yutai-summary"]) {
      vi.clearAllMocks();
      await main("install", kind);
      await main("install-next", kind);
      expect(io.preflight).toHaveBeenCalledTimes(2);
      expect(io.write).toHaveBeenCalledTimes(2);
      const [immediate, calendarOnly] = io.write.mock.calls as [string, string, { mode: number; flag: string }][];
      expect(immediate![1]).toContain("<key>RunAtLoad</key><true/>");
      expect(calendarOnly).toEqual([immediate![0], immediate![1].replace("<key>RunAtLoad</key><true/>", "<key>RunAtLoad</key><false/>"), { mode: 0o600, flag: "wx" }]);
      expect(immediate![2]).toEqual({ mode: 0o600, flag: "wx" });
      const hour = kind === "yutai-summary" ? 21 : 20;
      expect(calendarOnly![1]).toContain(`<key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>0</integer>`);
      expect(calendarOnly![1]).toContain("<key>Umask</key><integer>63</integer>");
      expect(io.exec.mock.calls.map(([command]) => command)).toEqual(["which", "plutil", "which", "plutil"]);
      expect(io.spawn).not.toHaveBeenCalled();
      expect(JSON.parse(log.mock.calls[0]![0] as string)).toMatchObject({ runAtLoad: true, bootstrapped: false });
      expect(JSON.parse(log.mock.calls[1]![0] as string)).toMatchObject({ runAtLoad: false, bootstrapped: false });
    }
  } finally { log.mockRestore(); }
});
