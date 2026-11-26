package core

import "testing"

func TestSingleMethodSchemaClosure(t *testing.T) {
	// Algorithmic core: a method schema retains recursive definitions and drops unrelated definitions.
	schema := schemaClosure(object{"$ref": "#/definitions/A"}, object{
		"A": object{"properties": object{"b": object{"$ref": "#/definitions/B"}}},
		"B": object{"$ref": "#/definitions/A"}, "Unrelated": object{"type": "string"},
	})
	definitions := obj(schema["definitions"])
	if len(definitions) != 2 || text(definitions["B"], "$ref") != "#/definitions/A" {
		t.Fatalf("wrong definition closure: %v", definitions)
	}
	if got := schemaClosure(object{"type": "null"}, object{"A": object{}}); wire(got) != `{"type":"null"}` {
		t.Fatalf("added unused definitions: %v", got)
	}
}
