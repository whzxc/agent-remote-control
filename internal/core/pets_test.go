package core

import (
	"archive/zip"
	"bytes"
	"os"
	"strings"
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
	budget := 1
	for _, input := range []string{"http://codex-pets.net/a", "https://raw.githubusercontent.com/other/repo/main/a", "https://evil.test/a"} {
		if _, err := nativePetDownload(t.Context(), input, &budget); err == nil || !strings.Contains(err.Error(), "download host or protocol is not allowed") {
			t.Fatalf("download %q = %v", input, err)
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
	for _, row := range []struct {
		name    string
		version int
	}{{"atlas-v1", 1}, {"atlas-v2", 2}} {
		sprite := fixtureWebP(t, row.name)
		manifest := object{"id": "fixture", "spritesheetPath": "spritesheet.webp", "spriteVersionNumber": row.version}
		info, err := validateNativePet([]byte(wire(manifest)), sprite)
		if err != nil || info["version"] != row.version || info["pixelArt"] != true {
			t.Fatalf("WebP atlas = %s, %v", wire(info), err)
		}
		manifest["spriteVersionNumber"] = 3 - row.version
		if _, err := validateNativePet([]byte(wire(manifest)), sprite); err == nil || !strings.Contains(err.Error(), "spriteVersionNumber disagree") {
			t.Fatalf("mismatched WebP atlas version = %v", err)
		}
		manifest["spriteVersionNumber"] = row.version
		delete(manifest, "id")
		if _, err := validateNativePet([]byte(wire(manifest)), sprite); err == nil || !strings.Contains(err.Error(), "needs id") {
			t.Fatalf("atlas without ID = %v", err)
		}
	}
	manifest := []byte(`{"id":"fixture","spritesheetPath":"spritesheet.webp"}`)
	if _, err := validateNativePet(manifest, fixtureWebP(t, "animated")); err == nil || !strings.Contains(err.Error(), "use a static atlas") {
		t.Fatalf("animated WebP atlas = %v", err)
	}
}

func TestNativePetArchiveRejectsTraversalDuplicatesAndSymlinks(t *testing.T) {
	// Algorithmic core: ZIP imports reject unsafe, duplicate, or unrelated entries before extraction.
	sprite := fixtureWebP(t, "atlas-v1")
	manifest := []byte(`{"id":"fixture","spritesheetPath":"spritesheet.webp"}`)
	for _, row := range []struct {
		names            [2]string
		symlink, allowed bool
	}{
		{names: [2]string{"pet.json", "spritesheet.webp"}, allowed: true},
		{names: [2]string{"../pet.json", "spritesheet.webp"}},
		{names: [2]string{"pet.json", "pet.json"}},
		{names: [2]string{"pet.json", "other.webp"}},
		{names: [2]string{"pet.json", "spritesheet.webp"}, symlink: true},
	} {
		var raw bytes.Buffer
		archive := zip.NewWriter(&raw)
		for i, data := range [][]byte{manifest, sprite} {
			header := &zip.FileHeader{Name: row.names[i]}
			if row.symlink && i == 1 {
				header.SetMode(os.ModeSymlink | 0700)
			}
			writer, err := archive.CreateHeader(header)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := writer.Write(data); err != nil {
				t.Fatal(err)
			}
		}
		if err := archive.Close(); err != nil {
			t.Fatal(err)
		}
		gotManifest, gotSprite, err := unpackNativePet(raw.Bytes())
		if (err == nil) != row.allowed || row.allowed && (!bytes.Equal(gotManifest, manifest) || !bytes.Equal(gotSprite, sprite)) {
			t.Fatalf("archive %+v = %v", row, err)
		}
	}
}
