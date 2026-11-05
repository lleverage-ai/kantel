"""Checks kantel-selkies' pixel budget against a stand-in for Selkies 2.2's websockets_mode (the names it wraps, with
the same signatures). Run: python3 kantel-selkies-test.py rootfs/usr/local/bin/kantel-selkies (the Go test
TestKantelSelkiesHoldsSizeAndDPIToTheBudget does)."""
import asyncio, importlib.machinery, importlib.util, json, sys, types

sys.dont_write_bytecode = True  # no __pycache__ in rootfs/, which goes into the image

calls = []


class Event:
    def __init__(self):
        self.v = False

    def is_set(self):
        return self.v


class DataStreamingServer:
    def __init__(self):
        self.client_settings_received = Event()

    def _parse_settings_payload(self, payload_str):
        d = json.loads(payload_str)
        return {k: d.get(k) for k in ("initialClientWidth", "initialClientHeight", "manual_resolution", "manual_width",
                                       "manual_height", "scaling_dpi")} | {"displayId": d.get("displayId") or "primary"}

    async def _handle_resize(self, res_str, display_id="primary"):
        calls.append(("resize", wm.parse_resize_dims(res_str), display_id))

    async def _handle_scaling(self, dpi_value, display_id="primary"):
        calls.append(("dpi", dpi_value, display_id))


def parse_resize_dims(s):
    try:
        w, h = s.split("x")
        return int(w), int(h)
    except ValueError:
        return None


pkg = types.ModuleType("selkies")
wm = types.ModuleType("selkies.websockets_mode")
wm.DataStreamingServer = DataStreamingServer
wm.parse_resize_dims = parse_resize_dims
pkg.websockets_mode = wm
sys.modules["selkies"] = pkg
sys.modules["selkies.websockets_mode"] = wm

loader = importlib.machinery.SourceFileLoader("ks", sys.argv[1])
spec = importlib.util.spec_from_loader("ks", loader)
ks = importlib.util.module_from_spec(spec)
loader.exec_module(ks)

ok = True


def check(name, got, want):
    global ok
    good = got == want
    ok &= good
    print(("ok  " if good else "FAIL"), name, got, "" if good else f"(want {want})")


B = 2560 * 1440
check("fit 3200x1800", ks.fit(3200, 1800, B), (2560, 1440))
check("fit small", ks.fit(1600, 900, B), (1600, 900))
check("fit off", ks.fit(3840, 2160, 0), (3840, 2160))
check("dpi held 0.8", ks.held_dpi(192, 0.8), 144)
check("dpi held 0.6", ks.held_dpi(192, 0.6), 120)
check("dpi floor", ks.held_dpi(96, 0.6), 96)
check("dpi none", ks.held_dpi(None, 0.5), None)
check("hold", ks.hold(B), True)

s = DataStreamingServer()


async def run():
    p = s._parse_settings_payload(json.dumps({"initialClientWidth": 3200, "initialClientHeight": 1800, "scaling_dpi": 192}))
    check("settings size", (p["initialClientWidth"], p["initialClientHeight"]), (2560, 1440))
    check("settings dpi", p["scaling_dpi"], 144)
    s.client_settings_received.v = True
    # Selkies echoes 144 to the page, which sends it back: still 144, not held again.
    p = s._parse_settings_payload(json.dumps({"initialClientWidth": 3200, "initialClientHeight": 1800, "scaling_dpi": 144}))
    check("echoed dpi", p["scaling_dpi"], 144)
    calls.clear()
    await s._handle_resize("2000x1200")  # under the budget: full size, the page's own DPI
    check("resize under", calls, [("resize", (2000, 1200), "primary"), ("dpi", 192, "primary")])
    calls.clear()
    await s._handle_resize("3840x2160")
    check("resize over", calls, [("resize", (2560, 1440), "primary"), ("dpi", 120, "primary")])
    calls.clear()
    await s._handle_resize("3840x2160")
    check("resize again, no DPI change", calls, [("resize", (2560, 1440), "primary")])
    calls.clear()
    await s._handle_scaling(96.0)  # the page moved to a DPR 1 screen
    check("dpr 1", calls, [("dpi", 96, "primary")])
    calls.clear()
    await s._handle_resize("1900x1000x")
    check("odd string passes through", calls, [("resize", None, "primary")])
    calls.clear()
    await s._handle_resize("3840x2160", "display2")
    check("other display: size held, DPI left", calls, [("resize", (2560, 1440), "display2")])
    p = s._parse_settings_payload(json.dumps({"manual_resolution": True, "manual_width": 7680, "manual_height": 4320}))
    check("manual held", (p["manual_width"], p["manual_height"]), (2560, 1440))


asyncio.run(run())
sys.exit(0 if ok else 1)
