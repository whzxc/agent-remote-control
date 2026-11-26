// Parse Go test cases for the same policy checker used by the daily tests.
package main

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"strings"
	"unicode"
	"unicode/utf16"
)

type assertion struct {
	Start int    `json:"start"`
	Text  string `json:"text"`
}

type testCase struct {
	Name       string      `json:"name"`
	Start      int         `json:"start"`
	End        int         `json:"end"`
	Line       int         `json:"line"`
	Comments   []string    `json:"comments"`
	Assertions []assertion `json:"assertions"`
}

func parseCases(path string) ([]testCase, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	positions := token.NewFileSet()
	file, err := parser.ParseFile(positions, path, data, parser.ParseComments|parser.SkipObjectResolution)
	if err != nil {
		return nil, err
	}
	extract := func(node ast.Node) string {
		return string(data[positions.Position(node.Pos()).Offset:positions.Position(node.End()).Offset])
	}
	offset := func(pos token.Pos) int {
		return len(utf16.Encode([]rune(string(data[:positions.Position(pos).Offset]))))
	}
	commentMap := ast.NewCommentMap(positions, file, file.Comments)
	cases := []testCase{}
	for _, decl := range file.Decls {
		fn, ok := decl.(*ast.FuncDecl)
		if !ok || fn.Recv != nil || fn.Body == nil {
			continue
		}
		name := fn.Name.Name
		suffix, test := strings.CutPrefix(name, "Test")
		if !test {
			suffix, test = strings.CutPrefix(name, "Fuzz")
		}
		if suffix != "" && unicode.IsLower([]rune(suffix)[0]) {
			test = false
		}
		if !test || name == "TestMain" {
			continue
		}
		testCase := testCase{Name: name, Start: offset(fn.Pos()), End: offset(fn.End()),
			Line: positions.Position(fn.Pos()).Line, Comments: []string{}, Assertions: []assertion{}}
		if fn.Doc != nil {
			for _, comment := range fn.Doc.List {
				testCase.Comments = append(testCase.Comments, comment.Text)
			}
		}
		for _, group := range commentMap.Filter(fn.Body).Comments() {
			for _, comment := range group.List {
				testCase.Comments = append(testCase.Comments, comment.Text)
			}
		}
		ast.Inspect(fn.Body, func(node ast.Node) bool {
			call, ok := node.(*ast.CallExpr)
			if !ok {
				return true
			}
			sel, ok := call.Fun.(*ast.SelectorExpr)
			if !ok {
				return true
			}
			switch sel.Sel.Name {
			case "Error", "Errorf", "Fatal", "Fatalf", "Fail", "FailNow":
				testCase.Assertions = append(testCase.Assertions, assertion{offset(call.Pos()), extract(call)})
			}
			return true
		})
		cases = append(cases, testCase)
	}
	return cases, nil
}

func main() {
	result := make(map[string][]testCase, len(os.Args)-1)
	for _, file := range os.Args[1:] {
		cases, err := parseCases(file)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		result[file] = cases
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
