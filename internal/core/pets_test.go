package core

import (
	"archive/zip"
	"bytes"
	"os"
	"testing"
)

func TestNativePetPageLimitsHostsAndPaths(t *testing.T) {
	// Algorithmic core: community pet links resolve only exact HTTPS hosts and one safe identifier.
	for _, url := range []string{
		"https://codex-pets.net/#/pets/claude-maiden",
		"https://codex-pets.net/pets/claude-maiden",
		"https://codexpet.top/pets/gpt--author",
	} {
		if site, slug, err := nativePetPage(url); err != nil || site == "" || slug == "" {
			t.Fatalf("page %q = %q, %q, %v", url, site, slug, err)
		}
	}
	for _, url := range []string{
		"http://codexpet.top/pets/a", "https://codexpet.top.evil/pets/a",
		"https://user@codexpet.top/pets/a", "https://codexpet.top/pets/../a",
		"https://codexpet.top/pets/a/b", "https://openpets.dev/pets/a",
	} {
		if _, _, err := nativePetPage(url); err == nil {
			t.Fatalf("page %q was accepted", url)
		}
	}
}

func TestNativePetAtlasMustMatchDeclaredVersion(t *testing.T) {
	// Algorithmic core: a static atlas must have the declared v1 or v2 dimensions.
	for _, row := range []struct {
		width, height, version int
		allowed                bool
	}{{1536, 1872, 1, true}, {1536, 2288, 2, true}, {1536, 1872, 2, false}, {192, 208, 1, false}} {
		data := fixtureNativePNG(t, row.width, row.height, false)
		manifest := []byte(wire(object{"id": "synthetic", "spritesheetPath": "spritesheet.png", "spriteVersionNumber": row.version}))
		info, err := validateNativePet(manifest, data)
		if (err == nil) != row.allowed || err == nil && info["version"] != row.version {
			t.Fatalf("atlas %dx%d v%d = %s, %v", row.width, row.height, row.version, wire(info), err)
		}
	}
	if _, err := validateNativePet([]byte(`{"id":"a","spritesheetPath":"../x.png"}`), nil); err == nil {
		t.Fatal("path traversal in atlas name was accepted")
	}
}

func TestNativePetArchiveRejectsTraversalDuplicatesAndSymlinks(t *testing.T) {
	// Algorithmic core: ZIP imports reject unsafe, duplicate, or unrelated entries before extraction.
	for _, names := range [][2]string{{"../pet.json", "spritesheet.png"}, {"pet.json", "pet.json"}, {"pet.json", "other.txt"}, {"pet.json", "symlink.png"}} {
		var raw bytes.Buffer
		archive := zip.NewWriter(&raw)
		for _, name := range names {
			header := &zip.FileHeader{Name: name}
			if name == "symlink.png" {
				header.SetMode(os.ModeSymlink | 0700)
			}
			writer, err := archive.CreateHeader(header)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write([]byte(`{"id":"a","spritesheetPath":"spritesheet.png"}`)); err != nil {
				t.Fatal(err)
			}
		}
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
		if _, _, err := unpackNativePet(raw.Bytes()); err == nil {
			t.Fatalf("unsafe archive %v accepted", names)
		}
	}
}
