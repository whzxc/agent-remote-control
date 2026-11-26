package core

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"image"
	"image/color"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/whzxc/agent-remote-control/internal/platform"
)

const nativePetPackageLimit = 25 << 20
const nativePetRawRepository = "https://raw.githubusercontent.com/legeling/awesome-codex-pet/main"

var nativePetMutation sync.Mutex

func nativePetSimpleName(value, extra string, limit int) bool {
	if value == "" || len(value) > limit {
		return false
	}
	for _, r := range value {
		if !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || strings.ContainsRune(extra, r)) {
			return false
		}
	}
	return true
}

func nativePetFilename(value string) bool {
	return !strings.HasPrefix(value, ".") && nativePetSimpleName(value, "-_.", 199)
}

func nativePetPage(input string) (string, string, error) {
	page, err := url.Parse(input)
	if err != nil || !page.IsAbs() {
		return "", "", errors.New("INVALID_ARGUMENT: enter a pet page HTTPS URL or choose ZIP")
	}
	if page.Scheme != "https" || page.User != nil || page.Port() != "" || page.RawQuery != "" || page.ForceQuery {
		return "", "", errors.New("INVALID_ARGUMENT: use an unmodified HTTPS pet page URL")
	}
	site, path := strings.ToLower(page.Hostname()), page.EscapedPath()
	if site == "codex-pets.net" && page.Fragment != "" {
		path = page.EscapedFragment()
	}
	slug, found := strings.CutPrefix(path, "/pets/")
	if !found || !nativePetSimpleName(slug, "-_", 200) || site != "codex-pets.net" && site != "codexpet.top" ||
		site == "codexpet.top" && strings.Contains(input, "#") {
		return "", "", errors.New("INVALID_ARGUMENT: supported links are codex-pets.net/pets/<id> and codexpet.top/pets/<slug>; use ZIP for other sites")
	}
	return site, slug, nil
}

func nativePetDownload(ctx context.Context, input string, budget *int) ([]byte, error) {
	parsed, err := url.Parse(input)
	if err != nil {
		return nil, err
	}
	site := strings.ToLower(parsed.Hostname())
	if parsed.Scheme != "https" || parsed.User != nil || parsed.Port() != "" ||
		site != "codex-pets.net" && (site != "raw.githubusercontent.com" || !strings.HasPrefix(parsed.EscapedPath(), "/legeling/awesome-codex-pet/main/")) {
		return nil, errors.New("INVALID_ARGUMENT: pet download host or protocol is not allowed")
	}
	client := http.Client{Timeout: time.Minute, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, input, nil)
	if err != nil {
		return nil, err
	}
	response, err := client.Do(request)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 300 && response.StatusCode < 400 || response.ContentLength > int64(*budget) {
		return nil, errors.New("INVALID_ARGUMENT: redirect or pet package exceeds 25 MB")
	}
	if response.StatusCode >= 400 {
		return nil, errors.New(response.Status)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, int64(*budget)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > *budget {
		return nil, errors.New("INVALID_ARGUMENT: pet package exceeds 25 MB")
	}
	*budget -= len(data)
	return data, nil
}

func parseNativePetJSON(data []byte) (object, error) {
	var value object
	if err := decodeObject(data, &value); err != nil {
		return nil, fmt.Errorf("INVALID_ARGUMENT: pet JSON: %w", err)
	}
	return value, nil
}

func nativePetAnimated(mime string, sprite []byte) bool {
	if mime == "image/png" {
		for sprite = sprite[8:]; len(sprite) >= 12; {
			size := uint64(binary.BigEndian.Uint32(sprite[:4])) + 12
			if size > uint64(len(sprite)) {
				return false
			}
			if string(sprite[4:8]) == "acTL" {
				return true
			}
			sprite = sprite[size:]
		}
	}
	if mime == "image/webp" {
		for sprite = sprite[12:]; len(sprite) >= 8; {
			payload := uint64(binary.LittleEndian.Uint32(sprite[4:8]))
			size := 8 + payload + payload%2
			if size > uint64(len(sprite)) {
				return false
			}
			switch string(sprite[:4]) {
			case "ANIM", "ANMF":
				return true
			case "VP8X":
				if payload > 0 && sprite[8]&2 != 0 {
					return true
				}
			}
			sprite = sprite[size:]
		}
	}
	return false
}

func nativePetPixelArt(atlas image.Image) bool {
	palette := map[color.NRGBA]bool{}
	for y := atlas.Bounds().Min.Y; y < atlas.Bounds().Max.Y; y++ {
		for x := atlas.Bounds().Min.X; x < atlas.Bounds().Max.X; x++ {
			pixel := color.NRGBAModel.Convert(atlas.At(x, y)).(color.NRGBA)
			if pixel.A == 0 {
				continue
			}
			palette[pixel] = true
			if len(palette) > 256 {
				return false
			}
		}
	}
	return len(palette) != 0
}

func validateNativePet(manifest, sprite []byte) (object, error) {
	if len(manifest)+len(sprite) > nativePetPackageLimit || len(manifest) > 65536 {
		return nil, errors.New("INVALID_ARGUMENT: pet package exceeds size limit")
	}
	value, err := parseNativePetJSON(manifest)
	if err != nil {
		return nil, err
	}
	id, path := text(value, "id"), text(value, "spritesheetPath")
	if strings.TrimSpace(id) == "" || len(id) > 200 || !nativePetFilename(path) {
		return nil, errors.New("INVALID_ARGUMENT: pet.json needs id and a simple spritesheetPath filename")
	}
	mime := nativeImageMIME(sprite, "")
	config, _, err := image.DecodeConfig(bytes.NewReader(sprite))
	if err != nil {
		return nil, fmt.Errorf("INVALID_ARGUMENT: spritesheet: %w", err)
	}
	version := 1
	if config.Width != 1536 || config.Height != 1872 && config.Height != 2288 {
		return nil, errors.New("INVALID_ARGUMENT: spritesheet must be a 1536x1872 v1 or 1536x2288 v2 atlas")
	}
	if config.Height == 2288 {
		version = 2
	}
	if mime != "image/png" && mime != "image/webp" {
		return nil, errors.New("INVALID_ARGUMENT: use a static PNG or WebP spritesheet")
	}
	if nativePetAnimated(mime, sprite) {
		return nil, errors.New("INVALID_ARGUMENT: use a static atlas; ARC owns frame animation")
	}
	atlas, _, err := image.Decode(bytes.NewReader(sprite))
	if err != nil {
		return nil, fmt.Errorf("INVALID_ARGUMENT: spritesheet decode: %w", err)
	}
	if declared, exists := value["spriteVersionNumber"]; exists && uintOr(declared, 0) != uint64(version) {
		return nil, errors.New("INVALID_ARGUMENT: atlas and spriteVersionNumber disagree")
	}
	name, supplied := value["displayName"]
	if !supplied {
		name = id
	}
	description, _ := value["description"].(string)
	var detail any
	if _, isString := value["description"].(string); isString {
		detail = description
	}
	return object{"id": id, "name": name, "description": detail, "version": version, "sprite": path, "pixelArt": nativePetPixelArt(atlas)}, nil
}

func unpackNativePet(data []byte) ([]byte, []byte, error) {
	if len(data) > nativePetPackageLimit {
		return nil, nil, errors.New("INVALID_ARGUMENT: ZIP exceeds 25 MB")
	}
	archive, err := zip.NewReader(bytes.NewReader(data), int64(len(data)))
	if err != nil {
		return nil, nil, fmt.Errorf("INVALID_ARGUMENT: ZIP: %w", err)
	}
	if len(archive.File) != 2 {
		return nil, nil, errors.New("INVALID_ARGUMENT: ZIP must contain only pet.json and its spritesheet at the root")
	}
	files := map[string][]byte{}
	available := int64(nativePetPackageLimit)
	for _, entry := range archive.File {
		_, found := files[entry.Name]
		if !nativePetFilename(entry.Name) || !entry.Mode().IsRegular() || found || entry.UncompressedSize64 > uint64(available) {
			return nil, nil, errors.New("INVALID_ARGUMENT: unsafe, duplicate or oversized ZIP entry")
		}
		reader, err := entry.Open()
		if err != nil {
			return nil, nil, err
		}
		value, readErr := io.ReadAll(io.LimitReader(reader, available+1))
		if err := errors.Join(readErr, reader.Close()); err != nil {
			return nil, nil, err
		}
		available -= int64(len(value))
		if available < 0 {
			return nil, nil, errors.New("INVALID_ARGUMENT: expanded ZIP exceeds 25 MB")
		}
		files[entry.Name] = value
	}
	manifest, found := files["pet.json"]
	if !found {
		return nil, nil, errors.New("INVALID_ARGUMENT: ZIP needs pet.json")
	}
	delete(files, "pet.json")
	value, err := parseNativePetJSON(manifest)
	if err != nil {
		return nil, nil, err
	}
	sprite, found := files[text(value, "spritesheetPath")]
	if !found {
		return nil, nil, errors.New("INVALID_ARGUMENT: ZIP needs the manifest spritesheet")
	}
	if _, err := validateNativePet(manifest, sprite); err != nil {
		return nil, nil, err
	}
	return manifest, sprite, nil
}

type nativePetEntry struct{ key, directory, origin string }

func nativePetEntries() []nativePetEntry {
	roots := []nativePetEntry{{directory: filepath.Join(root(), "pets"), origin: "arc"}}
	if home, err := nativeCodexHome(); err == nil {
		roots = append(roots, nativePetEntry{directory: filepath.Join(home, "pets"), origin: "codex"})
	}
	var result []nativePetEntry
	for _, location := range roots {
		rows, _ := os.ReadDir(location.directory)
		for _, entry := range rows {
			if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			dir := filepath.Join(location.directory, entry.Name())
			result = append(result, nativePetEntry{location.origin + ":" + hash([]byte(dir)), dir, location.origin})
		}
	}
	return result
}

func readNativePetFile(path, kind string, max int) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("INVALID_ARGUMENT: symlink " + kind)
	}
	if !info.Mode().IsRegular() || info.Size() > int64(max) {
		return nil, errors.New("INVALID_ARGUMENT: pet file exceeds size limit")
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !os.SameFile(info, opened) {
		return nil, errors.New("INVALID_ARGUMENT: pet file changed during read")
	}
	data, err := io.ReadAll(io.LimitReader(file, int64(max)+1))
	if err == nil && len(data) > max {
		err = errors.New("INVALID_ARGUMENT: pet file exceeds size limit")
	}
	return data, err
}

func nativePetPackage(entry nativePetEntry) (object, []byte, error) {
	manifest, err := readNativePetFile(filepath.Join(entry.directory, "pet.json"), "pet manifest", 65536)
	if err != nil {
		return nil, nil, err
	}
	meta, err := parseNativePetJSON(manifest)
	if err != nil {
		return nil, nil, err
	}
	name := text(meta, "spritesheetPath")
	if !nativePetFilename(name) {
		return nil, nil, errors.New("INVALID_ARGUMENT: unsafe spritesheet filename")
	}
	sprite, err := readNativePetFile(filepath.Join(entry.directory, name), "spritesheet", nativePetPackageLimit-len(manifest))
	if err != nil {
		return nil, nil, err
	}
	value, err := validateNativePet(manifest, sprite)
	return value, sprite, err
}

func listNativePets() object {
	packages, invalid := []object{}, []object{}
	for _, entry := range nativePetEntries() {
		info, _, err := nativePetPackage(entry)
		if err != nil {
			invalid = append(invalid, object{"key": entry.key, "error": err.Error()})
			continue
		}
		source, err := load(filepath.Join(entry.directory, "source.json"))
		if err != nil {
			source = object{"site": entry.origin, "pageUrl": nil, "author": nil, "license": nil, "attribution": nil}
		}
		info["key"], info["origin"], info["source"] = entry.key, entry.origin, source
		packages = append(packages, info)
	}
	return object{"packages": packages, "errors": invalid}
}

func installNativePet(manifest, sprite []byte, source object) (object, error) {
	info, err := validateNativePet(manifest, sprite)
	if err != nil {
		return nil, err
	}
	source["sha256"] = object{"petJson": hash(manifest), "spritesheet": hash(sprite)}
	source["installedAt"] = now()
	key := hash(bytes.Join([][]byte{manifest, sprite}, nil))
	base := filepath.Join(root(), "pets")
	if err := platform.PrivateDir(base); err != nil {
		return nil, err
	}
	nativePetMutation.Lock()
	defer nativePetMutation.Unlock()
	target := filepath.Join(base, key)
	rendering := object{"heuristicVersion": 1, "pixelArt": info["pixelArt"]}
	if found, err := os.Lstat(target); err == nil {
		if !found.IsDir() {
			return nil, errors.New("INVALID_ARGUMENT: unsafe pet installation path")
		}
		if err := save(filepath.Join(target, "rendering.json"), rendering); err != nil {
			return nil, err
		}
		return listNativePets(), nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	staging, err := os.MkdirTemp(base, ".install-")
	if err != nil {
		return nil, err
	}
	defer os.RemoveAll(staging)
	for name, data := range map[string][]byte{"pet.json": manifest, text(info, "sprite"): sprite} {
		if err := os.WriteFile(filepath.Join(staging, name), data, 0600); err != nil {
			return nil, err
		}
	}
	if err := save(filepath.Join(staging, "source.json"), source); err != nil {
		return nil, err
	}
	if err := save(filepath.Join(staging, "rendering.json"), rendering); err != nil {
		return nil, err
	}
	if err := os.Rename(staging, target); err != nil {
		return nil, err
	}
	return listNativePets(), nil
}

func installNativePetLink(ctx context.Context, input string) (object, error) {
	site, slug, err := nativePetPage(input)
	if err != nil {
		return nil, err
	}
	budget := nativePetPackageLimit
	download := func(path string) ([]byte, error) { return nativePetDownload(ctx, path, &budget) }
	var manifest, sprite []byte
	var author, license, attribution any
	if site == "codex-pets.net" {
		data, err := download("https://codex-pets.net/api/pets?q=" + slug + "&page=1&pageSize=60")
		if err != nil {
			return nil, err
		}
		index, err := parseNativePetJSON(data)
		if err != nil {
			return nil, err
		}
		entry := find(arr(index["pets"]), "id", slug)
		if entry == nil {
			return nil, errors.New("INVALID_ARGUMENT: exact pet id not found")
		}
		path := text(entry, "downloadUrl")
		if !strings.HasPrefix(path, "/api/pets/") {
			return nil, errors.New("INVALID_ARGUMENT: unexpected pet download URL")
		}
		data, err = download("https://codex-pets.net" + path)
		if err != nil {
			return nil, err
		}
		manifest, sprite, err = unpackNativePet(data)
		if err != nil {
			return nil, err
		}
		info, err := validateNativePet(manifest, sprite)
		if err != nil {
			return nil, err
		}
		size := "1536x1872"
		if info["version"] == 2 {
			size = "1536x2288"
		}
		if field(entry["validationReport"], "manifestId") != info["id"] || field(entry["validationReport"], "atlasSize") != size {
			return nil, errors.New("INVALID_ARGUMENT: package disagrees with site validationReport")
		}
		author, license, attribution = entry["ownerName"], entry["license"], entry["attribution"]
	} else {
		data, err := download(nativePetRawRepository + "/install-manifest.json")
		if err != nil {
			return nil, err
		}
		index, err := parseNativePetJSON(data)
		if err != nil {
			return nil, err
		}
		entry := obj(field(index["pets"], slug))
		if entry == nil {
			return nil, errors.New("INVALID_ARGUMENT: pet slug not found in install manifest")
		}
		base := nativePetRawRepository + "/pets/" + slug
		manifest, err = download(base + "/pet.json")
		if err != nil {
			return nil, err
		}
		sprite, err = download(base + "/spritesheet.webp")
		if err != nil {
			return nil, err
		}
		if hash(manifest) != entry["petJsonSha256"] || hash(sprite) != entry["spritesheetSha256"] ||
			uintOr(entry["petJsonBytes"], 0) != uint64(len(manifest)) || uintOr(entry["spritesheetBytes"], 0) != uint64(len(sprite)) {
			return nil, errors.New("INVALID_ARGUMENT: pet SHA-256 or size verification failed; retry after the publisher fixes the package")
		}
		info, err := validateNativePet(manifest, sprite)
		if err != nil {
			return nil, err
		}
		height := uint64(1872)
		if info["version"] == 2 {
			height = 2288
		}
		if uintOr(info["version"], 0) != uintOr(entry["spriteVersionNumber"], 0) ||
			uintOr(entry["spritesheetWidth"], 0) != 1536 || uintOr(entry["spritesheetHeight"], 0) != height {
			return nil, errors.New("INVALID_ARGUMENT: install manifest atlas mismatch")
		}
		data, err = download(base + "/submission.json")
		if err != nil {
			return nil, err
		}
		submission, err := parseNativePetJSON(data)
		if err != nil {
			return nil, err
		}
		author, license, attribution = submission["author"], submission["license"], submission["attribution"]
	}
	return installNativePet(manifest, sprite, object{"site": site, "pageUrl": "https://" + site + "/pets/" + slug, "author": author,
		"license": license, "attribution": attribution})
}

func init() {
	registerRoute(http.MethodGet, "pets", func(context.Context, *service, object, []string) (any, error) {
		return listNativePets(), nil
	})
	for _, action := range []string{"asset", "remove"} {
		registerRoute(http.MethodPost, "pets/"+action, func(_ context.Context, _ *service, args object, _ []string) (any, error) {
			if action == "remove" {
				nativePetMutation.Lock()
				defer nativePetMutation.Unlock()
			}
			for _, entry := range nativePetEntries() {
				if entry.key != args["key"] {
					continue
				}
				if action == "asset" {
					_, sprite, err := nativePetPackage(entry)
					if err != nil {
						return nil, err
					}
					return object{"dataUrl": "data:" + nativeImageMIME(sprite, "") + ";base64," + base64.StdEncoding.EncodeToString(sprite)}, nil
				}
				if entry.origin != "arc" {
					return nil, errors.New("INVALID_ARGUMENT: Codex pets are read-only; remove them in their owning application")
				}
				if err := os.RemoveAll(entry.directory); err != nil {
					return nil, fmt.Errorf("Failed to remove pet: %w", err)
				}
				return listNativePets(), nil
			}
			return nil, errors.New("INVALID_ARGUMENT: pet not installed; refresh pets")
		})
	}
	registerRoute(http.MethodPost, "pets/install", func(ctx context.Context, _ *service, args object, _ []string) (any, error) {
		return installNativePetLink(ctx, text(args, "url"))
	})
	registerRoute(http.MethodPost, "pets/import", func(_ context.Context, _ *service, args object, _ []string) (any, error) {
		encoded := text(args, "zip")
		if len(encoded) > ((nativePetPackageLimit+2)/3)*4 {
			return nil, errors.New("INVALID_ARGUMENT: ZIP exceeds 25 MB")
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil {
			return nil, errors.New("INVALID_ARGUMENT: ZIP must be base64")
		}
		manifest, sprite, err := unpackNativePet(data)
		if err != nil {
			return nil, err
		}
		meta, err := parseNativePetJSON(manifest)
		if err != nil {
			return nil, err
		}
		return installNativePet(manifest, sprite, object{"site": "zip", "pageUrl": nil, "author": meta["author"],
			"license": meta["license"], "attribution": meta["attribution"]})
	})
}
