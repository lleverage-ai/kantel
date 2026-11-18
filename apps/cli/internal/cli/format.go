package cli

import (
	"fmt"
	"math"
	"strings"
	"time"
)

// Table is rows under a header, columns padded to line up two spaces apart, the header dimmed.
func Table(s Styler, header []string, rows [][]string) string {
	widths := make([]int, len(header))
	for _, row := range append([][]string{header}, rows...) {
		for i, cell := range row {
			if i < len(widths) && Width(cell) > widths[i] {
				widths[i] = Width(cell)
			}
		}
	}
	line := func(row []string) string {
		parts := make([]string, len(row))
		for i, cell := range row {
			if i == len(row)-1 {
				parts[i] = cell
			} else {
				parts[i] = Pad(cell, widths[i])
			}
		}
		return strings.TrimRight(strings.Join(parts, "  "), " ")
	}
	out := []string{s.Paint(Dim, line(header))}
	for _, row := range rows {
		out = append(out, line(row))
	}
	return strings.Join(out, "\n")
}

// Field is one key and its value; an empty value leaves the row out.
type Field [2]string

// Fields is `key  value` lines, keys padded and dimmed; a row with no value is left out.
func Fields(s Styler, rows []Field) string { return fields(s, rows, false) }

// PlainFields is Fields with its keys left plain, as help's flag lists are.
func PlainFields(rows []Field) string { return fields(Styler{}, rows, true) }

func fields(s Styler, rows []Field, plainKeys bool) string {
	width := 0
	for _, r := range rows {
		if r[1] != "" && Width(r[0]) > width {
			width = Width(r[0])
		}
	}
	var out []string
	for _, r := range rows {
		if r[1] == "" {
			continue
		}
		key := Pad(r[0], width)
		if !plainKeys {
			key = s.Paint(Dim, key)
		}
		out = append(out, key+"  "+r[1])
	}
	return strings.Join(out, "\n")
}

func span(seconds float64) string {
	switch {
	case seconds < 60:
		return fmt.Sprintf("%ds", int(math.Max(0, math.Round(seconds))))
	case seconds < 3600:
		return fmt.Sprintf("%dm", int(math.Round(seconds/60)))
	case seconds < 86400:
		return fmt.Sprintf("%dh", int(math.Round(seconds/3600)))
	}
	return fmt.Sprintf("%dd", int(math.Round(seconds/86400)))
}

// Ago is how long ago an epoch-millisecond time was, such as `5m ago`.
func Ago(at int64, now time.Time) string {
	seconds := float64(now.UnixMilli()-at) / 1000
	if seconds < 5 {
		return "just now"
	}
	return span(seconds) + " ago"
}

// Until is how long until an epoch-millisecond time, such as `in 42m`.
func Until(at int64, now time.Time) string {
	seconds := float64(at-now.UnixMilli()) / 1000
	if seconds <= 0 {
		return "now"
	}
	return "in " + span(seconds)
}

// Duration is seconds as `1h 5m`.
func Duration(seconds float64) string {
	whole := int(math.Round(seconds))
	h, m := whole/3600, (whole%3600)/60
	switch {
	case h > 0:
		return fmt.Sprintf("%dh %dm", h, m)
	case m > 0:
		return fmt.Sprintf("%dm %ds", m, whole%60)
	}
	return fmt.Sprintf("%ds", whole)
}

// Bytes is a size such as `1.5 MiB`.
func Bytes(size float64) string {
	if size < 1024 {
		return fmt.Sprintf("%d B", int64(size))
	}
	units := []string{"KiB", "MiB", "GiB", "TiB"}
	value, unit := size/1024, 0
	for value >= 1024 && unit < len(units)-1 {
		value /= 1024
		unit++
	}
	if value < 10 {
		return fmt.Sprintf("%.1f %s", value, units[unit])
	}
	return fmt.Sprintf("%.0f %s", value, units[unit])
}

// Money is an amount such as `0.12 USD`; under 1, to a tenth of a cent, so a small rate isn't rounded away.
func Money(amount float64, currency string) string {
	if amount > 0 && amount < 1 {
		return fmt.Sprintf("%.3f %s", amount, currency)
	}
	return fmt.Sprintf("%.2f %s", amount, currency)
}

// Timestamp is an epoch-millisecond time as `2026-11-03 14:05 UTC`.
func Timestamp(at int64) string {
	return time.UnixMilli(at).UTC().Format("2006-01-02 15:04") + " UTC"
}
