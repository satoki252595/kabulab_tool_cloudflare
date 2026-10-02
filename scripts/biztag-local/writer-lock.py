"""Node所有FDを共有してkernel flockを取得。LOCK_UNせず子だけ終了する。"""
import datetime
import fcntl
import json
import os
import pathlib
import subprocess
import sys


def main():
    state = pathlib.Path(sys.argv[1])
    writer_pid = int(sys.argv[2])
    revision = sys.argv[3]
    descriptor = 3
    os.fchmod(descriptor, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        print(json.dumps({"locked": False}), flush=True)
        return
    # PID開始identityは診断用。所有権の正はkernel handleであり、PID再利用では誤認しない。
    identity = subprocess.check_output(["/bin/ps", "-p", str(writer_pid), "-o", "lstart="], text=True).strip()
    if not identity:
        raise RuntimeError("writer PIDの開始identityがありません")
    owner = {"writerPid": writer_pid, "processStarted": identity, "acquisitionPid": os.getpid(),
             "startedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(), "revision": revision}
    owner_path = state / "writer-owner.json"
    history = os.open(state / "writer-history.jsonl", os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    if owner_path.exists():
        # 以前のownerが残っても、新しいkernel取得で以前のhandle終端を証明済み。
        prior = json.loads(owner_path.read_text())
        os.write(history, (json.dumps({"prior": prior, "previousHandleEnded": True}) + "\n").encode())
    os.fsync(history)
    os.close(history)
    temporary = state / f"writer-owner-{os.getpid()}.json"
    temporary_fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    os.write(temporary_fd, json.dumps(owner).encode())
    os.fsync(temporary_fd)
    os.close(temporary_fd)
    os.replace(temporary, owner_path)
    print(json.dumps({"locked": True, **owner}), flush=True)
    # 明示LOCK_UNはしない。同じOFDを持つNode親がclose/終了するまで排他を保つ。


if __name__ == "__main__":
    main()
