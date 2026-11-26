// Command go-mutation exercises comparison and boolean mutations through Go overlays.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

type mutation struct {
	start, end  int
	replacement string
}

var operators = map[token.Token]string{
	token.EQL: "!=", token.NEQ: "==", token.LSS: "<=", token.LEQ: "<",
	token.GTR: ">=", token.GEQ: ">", token.LAND: "||", token.LOR: "&&",
}

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(files []string) error {
	if len(files) == 0 {
		return errors.New("choose explicitly scoped Go source files")
	}
	limit := 25
	if value := os.Getenv("ARC_MUTATION_LIMIT"); value != "" {
		n, err := strconv.Atoi(value)
		if err != nil || n < 1 {
			return errors.New("ARC_MUTATION_LIMIT must be a positive integer")
		}
		limit = n
	}
	if err := os.MkdirAll("output/mutation", 0755); err != nil {
		return err
	}
	dir, err := os.MkdirTemp("output/mutation", "go-")
	if err != nil {
		return err
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		return err
	}
	mutantPath, overlayPath := filepath.Join(dir, "mutant.go"), filepath.Join(dir, "overlay.json")
	defer os.Remove(mutantPath)
	defer os.Remove(overlayPath)
	survived, total := 0, 0
	for _, file := range files {
		raw, locations, err := mutations(file)
		if err != nil {
			return err
		}
		pkg := "./" + filepath.ToSlash(filepath.Dir(file))
		if err := goTest(pkg); err != nil {
			return fmt.Errorf("baseline failed for %s: %w", pkg, err)
		}
		absolute, err := filepath.Abs(file)
		if err != nil {
			return err
		}
		overlay, err := json.Marshal(map[string]map[string]string{"Replace": {absolute: mutantPath}})
		if err != nil {
			return err
		}
		if err := os.WriteFile(overlayPath, overlay, 0600); err != nil {
			return err
		}
		for i, item := range locations {
			if total == limit {
				break
			}
			total++
			mutant := string(raw[:item.start]) + item.replacement + string(raw[item.end:])
			if err := os.WriteFile(mutantPath, []byte(mutant), 0600); err != nil {
				return err
			}
			outcome := "killed"
			if err := goTest(pkg, "-overlay", overlayPath); err == nil {
				survived++
				outcome = "survived"
			}
			fmt.Printf("%s:%d %s %s\n", file, 1+strings.Count(string(raw[:item.start]), "\n"), item.replacement, outcome)
			if outcome == "survived" {
				if err := os.WriteFile(filepath.Join(dir, fmt.Sprintf("%s-%03d.txt", filepath.Base(file), i)), []byte(mutant), 0600); err != nil {
					return err
				}
			}
		}
	}
	fmt.Printf("%d of %d mutants survived (%s)\n", survived, total, dir)
	if survived > 0 || total == 0 {
		return errors.New("mutation audit found surviving mutants or no applicable operators")
	}
	return nil
}

func goTest(pkg string, flags ...string) error {
	args := append([]string{"test", "-count=1", "-timeout=2m", "-tags", "arcfixture"}, flags...)
	cmd := exec.Command("go", append(args, pkg)...)
	output, err := cmd.CombinedOutput()
	if err != nil {
		fmt.Fprint(os.Stderr, string(output))
	}
	return err
}

func mutations(file string) ([]byte, []mutation, error) {
	file = filepath.ToSlash(filepath.Clean(file))
	if !strings.HasPrefix(file, "internal/") || !strings.HasSuffix(file, ".go") || strings.HasSuffix(file, "_test.go") {
		return nil, nil, fmt.Errorf("choose an internal Go implementation file: %s", file)
	}
	raw, err := os.ReadFile(file)
	if err != nil {
		return nil, nil, err
	}
	set := token.NewFileSet()
	tree, err := parser.ParseFile(set, file, raw, 0)
	if err != nil {
		return nil, nil, err
	}
	var results []mutation
	ast.Inspect(tree, func(node ast.Node) bool {
		expression, ok := node.(*ast.BinaryExpr)
		if !ok {
			return true
		}
		if replacement, found := operators[expression.Op]; found {
			pos := set.Position(expression.OpPos).Offset
			results = append(results, mutation{pos, pos + len(expression.Op.String()), replacement})
		}
		return true
	})
	return raw, results, nil
}
