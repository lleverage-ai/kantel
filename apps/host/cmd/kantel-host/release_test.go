package main

import "testing"

func TestReleaseBase(t *testing.T) {
	for in, want := range map[string]string{
		"":       "https://github.com/lleverage-ai/kantel/releases/latest/download",
		"latest": "https://github.com/lleverage-ai/kantel/releases/latest/download",
		"0.2.0":  "https://github.com/lleverage-ai/kantel/releases/download/v0.2.0",
		"v0.2.0": "https://github.com/lleverage-ai/kantel/releases/download/v0.2.0",
	} {
		if got := releaseBase(in); got != want {
			t.Errorf("releaseBase(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestParseSums(t *testing.T) {
	a := "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0"
	b := "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	sums := parseSums(a + "  kantel-host-linux-amd64\n" + b + " *kantel-host-linux-arm64\nnot a line\n\n")
	if sums["kantel-host-linux-amd64"] != a {
		t.Errorf("amd64 = %q", sums["kantel-host-linux-amd64"])
	}
	if sums["kantel-host-linux-arm64"] != "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" {
		t.Errorf("arm64 = %q", sums["kantel-host-linux-arm64"])
	}
	if len(sums) != 2 {
		t.Errorf("got %d sums, want 2", len(sums))
	}
}
