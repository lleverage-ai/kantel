package protect

import (
	"slices"
	"strings"
	"testing"
)

func TestNewPlaceholder(t *testing.T) {
	seen := map[string]bool{}
	for range 200 {
		p, err := NewPlaceholder()
		if err != nil {
			t.Fatal(err)
		}
		if len(p) != PlaceholderLen || !strings.HasPrefix(p, PlaceholderPrefix) || !IsPlaceholder(p) {
			t.Fatalf("%q isn't a placeholder", p)
		}
		if seen[p] {
			t.Fatalf("%q came twice", p)
		}
		seen[p] = true
	}
}

func TestFind(t *testing.T) {
	ph := phGitHub
	other := phNPM
	tests := []struct {
		name string
		in   string
		want [][2]int
	}{
		{"alone", ph, [][2]int{{0, 44}}},
		{"after a scheme", "token " + ph, [][2]int{{6, 50}}},
		{"in a JSON string", `{"t":"` + ph + `"}`, [][2]int{{6, 50}}},
		{"two", ph + "," + other, [][2]int{{0, 44}, {45, 89}}},
		{"after an underscore", "_" + ph, [][2]int{{1, 45}}},
		{"after a short lookalike", "kph_abc " + ph, [][2]int{{8, 52}}},
		{"43 characters", ph[:43], nil},
		{"45 alphanumerics", ph + "x", nil},
		{"inside a word", "x" + ph, nil},
		{"after a digit", "9" + ph, nil},
		{"a non-alphanumeric inside", "kph_" + strings.Repeat("a", 39) + "-", nil},
		{"no prefix", strings.Repeat("a", 44), nil},
		{"empty", "", nil},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := Find([]byte(tt.in)); !slices.Equal(got, tt.want) {
				t.Fatalf("Find = %v, want %v", got, tt.want)
			}
		})
	}
}
