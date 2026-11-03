# @kantel/host

`kantel-host` runs Kantel sandboxes on a Linux machine you own: Firecracker microVMs (a full Debian with SSH, a
desktop, Chromium and Docker) and workerd isolates, behind one sandbox interface. The machine dials out to Kantel
over a WebSocket; it needs no inbound port.

Join a machine to Kantel with the command from Kantel's Hosts page:

```sh
sudo npx -y @kantel/host@latest install --url https://kantel.example.com --token kth_...
```

`install` checks `/dev/kvm`, copies the binary to `/usr/local/bin/kantel-host`, fetches Firecracker and the sandbox
images, registers with Kantel and starts the `kantel-host` systemd service. Without KVM, isolates can still run with
workerd on the machine itself (`--isolate-runtime native --tiers isolate`), for trusted code only.

Other commands: `kantel-host doctor`, `status`, `update`, `uninstall [--purge]`, `bench`. A global install
(`npm install -g @kantel/host`) gives the same `kantel-host` command.

The binary comes from a per-platform package, `@kantel/host-linux-x64` or `@kantel/host-linux-arm64`, which npm
installs as an optional dependency.
