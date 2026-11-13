# wgspike

Throwaway tool for the WireGuard throughput spike (LLE-18987). Not for merging.

`main.go` is one static binary (`GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build`) with subcommands: `keygen`,
`userspace` (wireguard-go over TUN), `kernel` (kernel WireGuard over netlink), `tcpserve`/`tcpsend`,
`httpserve`/`httpget` (HTTP/2 without TLS, 8 ranges of 64 MiB in flight, file dropped from the page cache
before each download), `mkfile` and `stat` (CPU jiffies, load, running CI jobs).

`measure.sh` runs one cross-host measurement, `all.sh` the kernel, userspace and raw series; `ceiling.sh`,
`ceil-all.sh` and `ceiling-remote.sh` the same-host network-namespace runs. Keys are placeholders here.
Results: `results2.jsonl` (cross-host) and `ceiling.jsonl` (same host). `attr` is CPU in cores charged to the
test processes, kernel worker and softirq threads and irq time; `cores` is the whole machine's.
