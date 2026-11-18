// Command kantel-docs writes the docs site's command reference, docs/site/src/content/docs/tools/cli-reference.md,
// from kantel's command table. -check writes nothing and fails when the page is out of date; the kantel package's
// TestReferenceIsCurrent checks the same in go test.
//
//	go run ./cmd/kantel-docs [-check]
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/lleverage-ai/kantel/apps/cli/internal/kantel"
)

func main() {
	check := flag.Bool("check", false, "write nothing; fail when the page is out of date")
	flag.Parse()
	cwd, _ := os.Getwd()
	path, err := kantel.ReferencePath(cwd)
	if err != nil {
		fmt.Fprintln(os.Stderr, "kantel-docs:", err)
		os.Exit(1)
	}
	page := kantel.Reference(kantel.Program().SchemaOf())
	if *check {
		current, _ := os.ReadFile(path)
		if string(current) != page {
			fmt.Fprintf(os.Stderr, "kantel-docs: %s is out of date: run go run ./cmd/kantel-docs in apps/cli\n", path)
			os.Exit(1)
		}
		return
	}
	if err := os.WriteFile(path, []byte(page), 0o644); err != nil {
		fmt.Fprintln(os.Stderr, "kantel-docs:", err)
		os.Exit(1)
	}
	fmt.Println("Wrote", path)
}
