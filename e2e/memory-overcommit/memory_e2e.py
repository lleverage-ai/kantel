#!/usr/bin/env python3
"""The memory over-commit E2E (experimental, `memoryOvercommit` in the host's config): how many microVMs a host admits,
what they hold after a peak, and what happens when all of them spike at once.

It runs against a Kantel you stood up yourself, with one kantel-host whose memory is limited (see README.md: a
privileged host container with --memory 16g --memory-swap 16g, kantel-host in a child control group of it). Stdlib
only. Every sandbox it makes is labelled e2e=memory-overcommit and recorded in made.txt beside this file, so
`cleanup` deletes them all; run it when you're done, and after any failure.

    export KANTEL_URL=http://127.0.0.1:<port>/v1 KANTEL_API_KEY=... KANTEL_HOST_ID=host_... KANTEL_HOST_CONTAINER=...
    python3 memory_e2e.py memory            # the host's memory report
    python3 memory_e2e.py fill 4096         # create 4 GiB microVMs until one is refused
    python3 memory_e2e.py spike 2400 200 60 # every one ramps to 2400 MiB at 200 MiB/s, holds 60 s; logs spike.log in the working directory
    python3 memory_e2e.py cleanup           # delete every sandbox it made
"""
import json
import os
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request

BASE = os.environ.get("KANTEL_URL", "http://127.0.0.1:8080/v1").rstrip("/")
KEY = os.environ.get("KANTEL_API_KEY", "")
HOST = os.environ.get("KANTEL_HOST_ID", "")
CONTAINER = os.environ.get("KANTEL_HOST_CONTAINER", "")
LABEL = "memory-overcommit"
HERE = os.path.dirname(os.path.abspath(__file__))
MADE = os.path.join(HERE, "made.txt")

# In the host container: each Firecracker's sandbox and resident MiB, and the VMs' control group (kantel-host's own).
VM_PROBE = r"""
own=/sys/fs/cgroup$(sed -n 's/^0:://p' /proc/$(pgrep -f 'kantel-host run' | head -1)/cgroup)
for p in $(pgrep -x firecracker); do
  echo "vm $(basename "$(dirname "$(readlink /proc/$p/cwd)")") rssMiB=$(awk '/VmRSS/{print int($2/1024)}' /proc/$p/status)"
done
echo "group currentMiB=$(( $(cat $own/memory.current) >> 20 )) max=$(cat $own/memory.max) swapMiB=$(( $(cat $own/memory.swap.current 2>/dev/null || echo 0) >> 20 )) $(grep -E '^(max|oom_kill) ' $own/memory.events | tr '\n' ' ')"
"""


def call(method, path, body=None, timeout=600):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(BASE + path, data=data, method=method)
    req.add_header("authorization", "Bearer " + KEY)
    if data is not None:
        req.add_header("content-type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return res.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw)
        except ValueError:
            return e.code, {"raw": raw.decode(errors="replace")}


def memory():
    _, host = call("GET", f"/admin/hosts/{HOST}")
    return (host or {}).get("memory"), (host or {}).get("allocated")


def show(m):
    keys = ["mode", "state", "reservedMiB", "committedMiB", "guestUsedMiB", "residentMiB", "availableMiB",
            "swapUsedMiB", "pressureSome", "pressureFull"]
    return " ".join(f"{k}={m.get(k)}" for k in keys) if m else "none"


def create(memory_mb):
    status, sbx = call("POST", "/sandboxes", {
        "type": "microvm", "resources": {"vcpus": 1, "memoryMb": memory_mb}, "autoStopMinutes": None,
        "wait": True, "labels": {"e2e": LABEL},
    })
    if status < 300 and sbx and sbx.get("id"):
        with open(MADE, "a") as f:
            f.write(sbx["id"] + "\n")
    return status, sbx or {}


def run(sid, command, timeout_ms):
    return call("POST", f"/sandboxes/{sid}/commands", {"command": command, "timeoutMs": timeout_ms},
                timeout=timeout_ms / 1000 + 30)


def ours():
    _, listed = call("GET", "/sandboxes?limit=200")
    return [s for s in (listed or {}).get("items", []) if s.get("labels", {}).get("e2e") == LABEL]


def cleanup():
    ids = open(MADE).read().split() if os.path.exists(MADE) else []
    ids += [s["id"] for s in ours() if s["id"] not in ids]
    for sid in ids:
        status, _ = call("DELETE", f"/sandboxes/{sid}")
        print("delete", sid, status)
    live = []
    for _ in range(60):
        live = [s["id"] for s in ours() if s.get("state") != "deleted"]
        if not live:
            break
        time.sleep(2)
    print("left", live)
    if not live and os.path.exists(MADE):
        os.remove(MADE)
    return not live


def fill(size):
    n = 0
    while n < 40:
        t = time.time()
        status, sbx = create(size)
        m, _ = memory()
        ok = status < 300 and sbx.get("state") == "running"
        print(f"create {n + 1}: {status} {sbx.get('id') if ok else sbx.get('reason')} in {time.time() - t:.1f}s | {show(m)}",
              flush=True)
        if not ok:
            break
        n += 1
        time.sleep(12)  # two usage readings, so the new VM is measured before the next create
    print("admitted", n)


def spike(peak, step, hold, log_path):
    prog = (f"import time\nchunks = []\nfor i in range({peak} // {step}):\n"
            f"    chunks.append(bytearray(b'\\x01') * ({step} << 20))\n    print('held', (i + 1) * {step}, flush=True)\n"
            f"    time.sleep(1)\ntime.sleep({hold})\nprint('done', flush=True)\n")
    command = "python3 -c \"" + prog.replace('"', '\\"') + "\""
    ids = [s["id"] for s in ours() if s["state"] == "running"]
    results, stop = {}, threading.Event()
    log = open(log_path, "w")

    def one(sid):
        t = time.time()
        status, cmd = run(sid, command, (peak // step + hold + 60) * 1000)
        results[sid] = (status, time.time() - t, cmd or {})

    def watch():
        while not stop.is_set():
            m, _ = memory()
            print(f"{time.strftime('%H:%M:%S')} {show(m)}", file=log, flush=True)
            if CONTAINER:
                out = subprocess.run(["docker", "exec", CONTAINER, "sh", "-c", VM_PROBE], capture_output=True, text=True)
                for line in out.stdout.splitlines():
                    print("   ", line, file=log, flush=True)
            stop.wait(2)

    watcher = threading.Thread(target=watch)
    watcher.start()
    threads = [threading.Thread(target=one, args=(sid,)) for sid in ids]
    for t in threads:
        t.start()
    time.sleep(peak // step + 5)
    status, sbx = create(4096)
    print(f"create mid-spike: {status} state={sbx.get('state')} reason={sbx.get('reason')}", flush=True)
    for t in threads:
        t.join()
    stop.set()
    watcher.join()
    for sid, (status, took, cmd) in sorted(results.items()):
        out = cmd.get("stdout", "").strip()
        print(sid, status, f"{took:.0f}s", f"exit={cmd.get('exitCode')}", "last=" + (out.splitlines()[-1] if out else ""),
              "stderr=" + cmd.get("stderr", "")[-200:].replace("\n", " "), flush=True)
    for s in ours():
        print("after", s["id"], s["state"], s.get("reason") or "")


if __name__ == "__main__":
    if not KEY or not HOST:
        sys.exit("set KANTEL_URL, KANTEL_API_KEY and KANTEL_HOST_ID (and KANTEL_HOST_CONTAINER for per-VM readings)")
    what = sys.argv[1] if len(sys.argv) > 1 else "memory"
    args = [int(a) for a in sys.argv[2:]]
    if what == "memory":
        m, a = memory()
        print(show(m), "allocated", a)
    elif what == "fill":
        fill(*(args or [4096]))
    elif what == "spike":
        spike(*(args + [2400, 200, 60][len(args):]), os.path.abspath("spike.log"))
    elif what == "cleanup":
        sys.exit(0 if cleanup() else 1)
    else:
        sys.exit(__doc__)
