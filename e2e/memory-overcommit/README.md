# Memory over-commit E2E

Measures the experimental `memoryOvercommit` host setting (see `docs/site/src/content/docs/hosts.md`, Memory
over-commit) on a host whose memory is small enough to fill: how many microVMs it admits, what they hold after a
peak, and what happens when they all spike at once.

It needs a Kantel you stand up yourself (a local install), with one kantel-host in a privileged container limited to
16 GiB and no swap, kantel-host in a child control group of it as on a systemd host:

```sh
docker run -d --name kt-host --privileged --device /dev/kvm --device /dev/net/tun --shm-size 8g \
  --memory 16g --memory-swap 16g --network <the install's control network> \
  -v kt-hostdata:/var/lib/kantel-host -v "$PWD/e2e/memory-overcommit:/e2e" <an image with kantel-host> /e2e/host-entry.sh
```

Then, with the host enrolled and `memoryOvercommit` set in its config as you want it:

```sh
export KANTEL_URL=http://127.0.0.1:<port>/v1 KANTEL_API_KEY=... KANTEL_HOST_ID=host_... KANTEL_HOST_CONTAINER=kt-host
python3 e2e/memory-overcommit/memory_e2e.py fill 4096          # 4 GiB microVMs until one is refused
python3 e2e/memory-overcommit/memory_e2e.py spike 2400 200 60  # all ramp to 2400 MiB at 200 MiB/s at once
python3 e2e/memory-overcommit/memory_e2e.py cleanup            # always: deletes every sandbox it made
```

`spike` logs the host's memory report, each Firecracker's resident memory and the group's use, limit and
`memory.events` every 2 seconds to `spike.log`, tries a create mid-spike, and prints how each sandbox's command ended.
What to look for: no swap, the group's `oom_kill` at 0 (the guard acted before the kernel had to), each sandbox hit
saying it ran out of memory, the mid-spike create refused, and the residents falling after the spike.

Measured on 7 Nov 2026 (16 GiB container, 2 GiB reserve, 4 GiB microVMs): 5 admitted with it off, 8 with it on (its
`maxRatio` 2.5). All 8 ramping to 2.4 GiB at once: no swap, no VM ended by the kernel, six guests killed their largest
process, the create mid-spike was refused, and the 8 held 5.9 GiB 30 seconds after (15.9 GiB at the peak).
