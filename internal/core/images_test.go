package core

import (
	"bytes"
	"encoding/base64"
	"image"
	"image/color"
	"image/gif"
	"image/jpeg"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixtureNativePNG(t *testing.T, width, height int, noisy bool) []byte {
	t.Helper()
	value := uint32(7)
	canvas := image.NewNRGBA(image.Rect(0, 0, width, height))
	for y := range height {
		for x := range width {
			pixel := color.NRGBA{R: 12, G: 34, B: 56, A: 255}
			if noisy {
				value ^= value << 13
				value ^= value >> 17
				value ^= value << 5
				pixel = color.NRGBA{R: byte(value), G: byte(value >> 8), B: byte(value >> 16), A: 255}
			}
			canvas.SetNRGBA(x, y, pixel)
		}
	}
	var output bytes.Buffer
	if err := png.Encode(&output, canvas); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}

func TestNativeImageDetectsContentBeforeExtension(t *testing.T) {
	// Algorithmic core: image format detection uses magic bytes before the extension.
	for _, v := range []struct {
		data []byte
		mime string
	}{
		{fixtureNativePNG(t, 3, 2, false), "image/png"},
		{[]byte("\xff\xd8\xff\xe0"), "image/jpeg"},
		{[]byte("GIF89a"), "image/gif"},
		{[]byte("RIFF\x00\x00\x00\x00WEBP"), "image/webp"},
	} {
		if got := nativeImageMIME(v.data, "wrong.bin"); got != v.mime {
			t.Fatalf("image type = %q, want %q", got, v.mime)
		}
	}
	if _, err := prepareNativeImage([]byte("not an image"), "fake.png", nil); err == nil || !strings.HasPrefix(err.Error(), "INVALID_IMAGE:") {
		t.Fatalf("image decoding error = %v", err)
	}
	if _, err := projectText([]byte("%PDF-1.7\x00binary"), "fake.bin"); err == nil || !strings.Contains(err.Error(), "type=pdf, bytes=15") {
		t.Fatalf("binary file error = %v", err)
	}
}

func TestNativeImageScalesAndBoundsOutput(t *testing.T) {
	// Algorithmic core: image preparation enforces both dimension and encoded byte limits.
	scaled, err := prepareNativeImage(fixtureNativePNG(t, 2400, 1200, false), "large.png", nil)
	if err != nil || scaled.metadata["width"] != 1568 || scaled.metadata["height"] != 784 {
		t.Fatalf("scaled metadata = %s, %v", wire(scaled.metadata), err)
	}
	bounded, err := prepareNativeImage(fixtureNativePNG(t, 1600, 1600, true), "noise.png", nil)
	if err != nil {
		t.Fatal(err)
	}
	data, err := base64.StdEncoding.DecodeString(text(bounded.content, "data"))
	if err != nil || len(data) > nativeImageMaxBytes || bounded.content["mimeType"] != "image/png" {
		t.Fatalf("bounded output = %s, %v", wire(bounded.metadata), err)
	}
	got, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || got.Width != bounded.metadata["width"] || got.Width >= 1568 {
		t.Fatalf("bounded size = %v, %v", got, err)
	}
}

func TestNativeImagePreservesBoundedOriginal(t *testing.T) {
	// Algorithmic core: bounded input is preserved and a small resize must not inflate the original.
	canvas := image.NewNRGBA(image.Rect(0, 0, 40, 20))
	var jpegData, gifData bytes.Buffer
	if err := jpeg.Encode(&jpegData, canvas, nil); err != nil {
		t.Fatal(err)
	}
	if err := gif.Encode(&gifData, canvas, nil); err != nil {
		t.Fatal(err)
	}
	for mime, original := range map[string][]byte{
		"image/png": fixtureNativePNG(t, 40, 20, false), "image/jpeg": jpegData.Bytes(),
		"image/gif": gifData.Bytes(), "image/webp": fixtureWebP(t, "opaque"),
	} {
		bounded, err := prepareNativeImage(original, "image.bin", object{"quality": 1})
		if err != nil {
			t.Fatal(err)
		}
		if data, err := base64.StdEncoding.DecodeString(text(bounded.content, "data")); err != nil || !bytes.Equal(data, original) ||
			bounded.metadata["sha256"] != bounded.metadata["returnedSha256"] || bounded.metadata["reencoded"] != false ||
			bounded.content["mimeType"] != mime {
			t.Fatalf("bounded %s original = %s, %v", mime, wire(bounded.metadata), err)
		}
	}
	input, err := png.Decode(bytes.NewReader(fixtureNativePNG(t, 1620, 863, true)))
	if err != nil {
		t.Fatal(err)
	}
	var original bytes.Buffer
	if err := jpeg.Encode(&original, input, &jpeg.Options{Quality: 10}); err != nil {
		t.Fatal(err)
	}
	small, err := prepareNativeImage(original.Bytes(), "small-resize.jpg", nil)
	if err != nil || small.metadata["reencoded"] != false || small.metadata["width"] != 1620 {
		t.Fatalf("small reduction = %s, %v", wire(small.metadata), err)
	}
	large, err := prepareNativeImage(original.Bytes(), "large-resize.jpg", object{"maxEdge": 1400})
	if err != nil || large.metadata["reencoded"] != true || uintOr(large.metadata["width"], 0) > 1400 {
		t.Fatalf("large reduction = %s, %v", wire(large.metadata), err)
	}
	overBudget := fixtureNativePNG(t, 800, 800, true)
	reduced, err := prepareNativeImage(overBudget, "oversized.png", nil)
	if len(overBudget) <= nativeImageMaxBytes || err != nil || reduced.metadata["reencoded"] != true ||
		uintOr(reduced.metadata["bytes"], 0) > nativeImageMaxBytes {
		t.Fatalf("below-edge byte budget = %s, %v", wire(reduced.metadata), err)
	}
}

func TestNativeThreadImagesRespectWorkspaceAndThreadScope(t *testing.T) {
	// Recurring bug class: security an image from another workspace or native thread cannot be returned.
	dir := t.TempDir()
	workspace := filepath.Join(dir, "project")
	outside := filepath.Join(dir, "outside.png")
	visuals := filepath.Join(dir, "visualizations")
	own := filepath.Join(visuals, "2026", "01", "01", "test-thread", "image.png")
	for _, parent := range []string{workspace, filepath.Dir(own)} {
		if err := os.MkdirAll(parent, 0700); err != nil {
			t.Fatal(err)
		}
	}
	imageBytes := fixtureNativePNG(t, 3, 2, false)
	for _, file := range []string{filepath.Join(workspace, "image.png"), outside, own} {
		if err := os.WriteFile(file, imageBytes, 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("CODEX_HOME", dir)
	workspace, _ = canonicalProjectPath(workspace)
	visuals, _ = canonicalProjectPath(visuals)
	own, _ = canonicalProjectPath(own)
	if _, err := nativeVisualPath(own, visuals, "test-thread"); err != nil {
		t.Fatal(err)
	}
	if _, err := nativeVisualPath(own, visuals, "other-thread"); err == nil {
		t.Fatal("another thread's visualization was accepted")
	}
	for _, file := range []string{outside, "../outside.png"} {
		if _, err := nativeImagePath(file, "test-thread", workspace); err == nil {
			t.Fatalf("out-of-workspace file %q was accepted", file)
		}
	}
	if operatingSystem != "windows" {
		if err := os.Symlink(outside, filepath.Join(workspace, "escape.png")); err != nil {
			t.Fatal(err)
		}
		if _, err := nativeImagePath("escape.png", "test-thread", workspace); err == nil {
			t.Fatal("out-of-workspace symlink was accepted")
		}
	}
	items := []any{object{"id": "fixture-item", "type": "agentMessage", "text": "![image](image.png)"}}
	value := object{"items": items}
	original := egressTool(clone(value), false)
	attachNativeImages(value, nativeImagesFromItems(items, "test-thread", workspace, object{}))
	if got := egressTool(value, false); wire(got) != wire(original) {
		t.Fatalf("default result changed: %s", wire(got))
	}
	if blocks := nativeImagesFromItems(items, "test-thread", workspace, object{"includeImages": true}); len(blocks) != 2 || field(blocks[1], "type") != "image" {
		t.Fatalf("workspace image blocks = %s", wire(blocks))
	}
	inline := "data:image/png;base64," + base64.StdEncoding.EncodeToString(imageBytes)
	items = []any{object{"id": "fixture-tool", "type": "mcpToolCall", "result": object{"screenshot": object{"url": inline}}}}
	if blocks := nativeImagesFromItems(items, "test-thread", workspace, object{"includeImages": true}); len(blocks) != 2 ||
		field(blocks[1], "mimeType") != "image/png" || strings.Contains(text(blocks[0], "text"), "base64") {
		t.Fatalf("embedded evidence = %s", wire(blocks))
	}
}

func fixtureWebP(t *testing.T, name string) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "go-a-webp", name+".webp"))
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func TestNativeWebPResizingPreservesAlphaAndUsesFirstAnimationFrame(t *testing.T) {
	// Contract: attachment resizing preserves alpha and projects the first frame of animated WebP.
	for _, row := range []struct {
		name, mime string
		alpha      uint8
	}{{"opaque", "image/jpeg", 255}, {"alpha", "image/png", 128}, {"animated", "image/jpeg", 255}} {
		original := fixtureWebP(t, row.name)
		bounded, err := prepareNativeImage(original, "image.webp", object{"maxEdge": 2048})
		if err != nil || bounded.content["mimeType"] != "image/webp" || bounded.content["data"] != base64.StdEncoding.EncodeToString(original) {
			t.Fatalf("%s original = %s, %v", row.name, wire(bounded.metadata), err)
		}
		prepared, err := prepareNativeImage(original, "image.webp", object{"maxEdge": 8})
		if err != nil || prepared.content["mimeType"] != row.mime || prepared.metadata["reencoded"] != true {
			t.Fatalf("%s resize = %s, %v", row.name, wire(prepared.metadata), err)
		}
		data, err := base64.StdEncoding.DecodeString(text(prepared.content, "data"))
		if err != nil {
			t.Fatal(err)
		}
		decoded, _, err := image.Decode(bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		pixel := color.NRGBAModel.Convert(decoded.At(0, 0)).(color.NRGBA)
		if max(decoded.Bounds().Dx(), decoded.Bounds().Dy()) != 8 || pixel.A != row.alpha ||
			row.name == "animated" && (pixel.R < 10 || pixel.R > 14) {
			t.Fatalf("%s resized bounds = %v, first pixel = %v", row.name, decoded.Bounds(), pixel)
		}
	}
}
