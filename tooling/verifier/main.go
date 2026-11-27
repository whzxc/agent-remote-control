// Command verifier signs and verifies ARC's Tauri and MyGo updater payloads.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"debug/buildinfo"
	"debug/elf"
	"debug/pe"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"

	"aead.dev/minisign"
)

func main() {
	if err := run(os.Args[1:]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run(args []string) error {
	if len(args) == 2 && args[0] == "generate-rehearsal-keys" {
		return generateKeys(args[1])
	}
	if len(args) < 2 {
		return errors.New("Usage: verifier <check-keys|sign-tauri|verify-tauri|sign-mygo|verify-mygo|verify-windows|verify-linux> <version> [artifact | artifact signature]")
	}
	switch args[0] {
	case "check-keys":
		if _, err := tauriPrivate(); err != nil {
			return err
		}
		_, err := mygoPrivate()
		return err
	case "sign-tauri", "verify-tauri":
		if len(args) < 3 {
			return errors.New("Provide at least one Tauri artifact")
		}
		for _, file := range args[2:] {
			if err := tauriArtifact(file, args[1], args[0] == "sign-tauri"); err != nil {
				return fmt.Errorf("%s: %w", filepath.Base(file), err)
			}
		}
		fmt.Printf("Verified %d Tauri artifact signature(s).\n", len(args)-2)
		return nil
	case "sign-mygo":
		if len(args) != 3 {
			return errors.New("Provide one MyGo archive")
		}
		key, err := mygoPrivate()
		if err != nil {
			return err
		}
		digest, err := archiveDigest(args[2])
		if err != nil {
			return err
		}
		fmt.Println(base64.StdEncoding.EncodeToString(ed25519.Sign(key, digest)))
		return nil
	case "verify-mygo":
		if len(args) != 4 {
			return errors.New("Provide one MyGo archive and its manifest signature")
		}
		key, err := publicBytes("ARC_MYGO_UPDATE_PUBLIC_KEY", ed25519.PublicKeySize)
		if err != nil {
			return err
		}
		digest, err := archiveDigest(args[2])
		if err != nil {
			return err
		}
		signature, err := base64.StdEncoding.DecodeString(args[3])
		if err != nil || !ed25519.Verify(ed25519.PublicKey(key), digest, signature) {
			return errors.New("MyGo archive signature does not verify")
		}
		fmt.Println("Verified MyGo archive signature.")
		return nil
	case "verify-windows":
		if len(args) < 3 {
			return errors.New("Provide at least one Windows x64 PE executable")
		}
		for _, file := range args[2:] {
			if err := verifyWindowsBinary(file, args[1]); err != nil {
				return fmt.Errorf("%s: %w", filepath.Base(file), err)
			}
		}
		fmt.Printf("Verified %d Windows x64 binary(s).\n", len(args)-2)
		return nil
	case "verify-linux":
		if len(args) != 4 {
			return errors.New("Usage: verifier verify-linux <version> <x86_64|aarch64> <binary>")
		}
		if err := verifyLinuxBinary(args[3], args[2], args[1]); err != nil {
			return fmt.Errorf("%s: %w", filepath.Base(args[3]), err)
		}
		fmt.Printf("Verified static Linux %s binary.\n", args[2])
		return nil
	default:
		return errors.New("Unknown verifier operation")
	}
}

func checkBuildInfo(path, wantOS, wantArch, version string) error {
	info, err := buildinfo.ReadFile(path)
	if err != nil {
		return fmt.Errorf("cannot read Go build info: %w", err)
	}
	settings := map[string]string{}
	for _, s := range info.Settings {
		settings[s.Key] = s.Value
	}
	if settings["GOOS"] != wantOS || settings["GOARCH"] != wantArch {
		return fmt.Errorf("expected Go target %s/%s, got %s/%s", wantOS, wantArch, settings["GOOS"], settings["GOARCH"])
	}
	if settings["CGO_ENABLED"] != "0" {
		return fmt.Errorf("expected CGO_ENABLED=0, got %q", settings["CGO_ENABLED"])
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	if !bytes.Contains(data, []byte(version)) {
		return fmt.Errorf("embedded version %s not found in binary", version)
	}
	return nil
}

func verifyWindowsBinary(path, version string) error {
	f, err := pe.Open(path)
	if err != nil {
		return fmt.Errorf("invalid PE binary: %w", err)
	}
	machine := f.Machine
	_ = f.Close()
	if machine != pe.IMAGE_FILE_MACHINE_AMD64 {
		return fmt.Errorf("expected Windows x86_64 PE (0x8664), got 0x%x", machine)
	}
	return checkBuildInfo(path, "windows", "amd64", version)
}

func verifyLinuxBinary(path, arch, version string) error {
	var wantMachine elf.Machine
	var wantGoArch string
	switch arch {
	case "x86_64":
		wantMachine, wantGoArch = elf.EM_X86_64, "amd64"
	case "aarch64":
		wantMachine, wantGoArch = elf.EM_AARCH64, "arm64"
	default:
		return fmt.Errorf("unsupported Linux arch %q", arch)
	}
	f, err := elf.Open(path)
	if err != nil {
		return fmt.Errorf("invalid ELF binary: %w", err)
	}
	defer f.Close()
	if f.Class != elf.ELFCLASS64 || f.Data != elf.ELFDATA2LSB ||
		(f.Type != elf.ET_EXEC && f.Type != elf.ET_DYN) || f.Machine != wantMachine {
		return fmt.Errorf("expected little-endian Linux %s ELF64 executable", arch)
	}
	for _, prog := range f.Progs {
		if prog.Type == elf.PT_INTERP {
			return errors.New("Linux Core must be statically linked (unexpected PT_INTERP)")
		}
	}
	if libs, err := f.ImportedLibraries(); err == nil && len(libs) > 0 {
		return fmt.Errorf("Linux Core must not require shared libraries: %v", libs)
	}
	if syms, err := f.DynamicSymbols(); err == nil {
		for _, sym := range syms {
			if strings.Contains(sym.Version, "GLIBC_") || strings.Contains(sym.Library, "libc.so") {
				return fmt.Errorf("Linux Core must be independent of system libc (%s)", sym.Version)
			}
		}
	}
	return checkBuildInfo(path, "linux", wantGoArch, version)
}

func publicBytes(variable string, length int) ([]byte, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(os.Getenv(variable)))
	if err != nil || len(key) == 0 || length != 0 && len(key) != length {
		return nil, fmt.Errorf("%s must contain the expected Base64 public key", variable)
	}
	return key, nil
}

func tauriPublic() (key minisign.PublicKey, err error) {
	encoded, err := publicBytes("ARC_TAURI_UPDATE_PUBLIC_KEY", 0)
	if err == nil {
		err = key.UnmarshalText([]byte(strings.TrimSpace(string(encoded))))
	}
	return key, err
}

func readSecret(variable string) ([]byte, error) {
	path := os.Getenv(variable)
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("%s must identify an explicit absolute key file", variable)
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("cannot read the file named by %s", variable)
	}
	return []byte(strings.TrimSpace(string(bytes))), nil
}

func tauriPrivate() (key minisign.PrivateKey, err error) {
	pub, err := tauriPublic()
	if err != nil {
		return key, err
	}
	data, err := readSecret("TAURI_SIGNING_PRIVATE_KEY_FILE")
	if err != nil {
		return key, err
	}
	if !strings.HasPrefix(string(data), "untrusted comment:") {
		data, err = base64.StdEncoding.DecodeString(string(data))
		if err != nil {
			return key, errors.New("invalid Tauri private key envelope")
		}
	}
	if minisign.IsEncrypted(data) {
		key, err = minisign.DecryptKey(os.Getenv("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"), data)
	} else {
		err = key.UnmarshalText(data)
	}
	if err != nil {
		return key, errors.New("cannot decode the Tauri signing key")
	}
	if !pub.Equal(key.Public()) {
		return key, errors.New("Tauri public and private keys do not match")
	}
	return key, nil
}

func mygoPrivate() (ed25519.PrivateKey, error) {
	pub, err := publicBytes("ARC_MYGO_UPDATE_PUBLIC_KEY", ed25519.PublicKeySize)
	if err != nil {
		return nil, err
	}
	data, err := readSecret("ARC_MYGO_UPDATE_PRIVATE_KEY_FILE")
	if err != nil {
		return nil, err
	}
	decoded, err := base64.StdEncoding.DecodeString(string(data))
	if err != nil || len(decoded) != ed25519.PrivateKeySize {
		return nil, errors.New("invalid MyGo signing key")
	}
	key := ed25519.NewKeyFromSeed(decoded[:ed25519.SeedSize])
	if !key.Equal(ed25519.PrivateKey(decoded)) || !key.Public().(ed25519.PublicKey).Equal(ed25519.PublicKey(pub)) {
		return nil, errors.New("MyGo public and private keys do not match")
	}
	return key, nil
}

func tauriArtifact(file, version string, sign bool) error {
	pub, err := tauriPublic()
	if err != nil {
		return err
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	if sign {
		key, err := tauriPrivate()
		if err != nil {
			return err
		}
		reader := minisign.NewReader(f)
		if _, err := io.Copy(io.Discard, reader); err != nil {
			return err
		}
		comment := fmt.Sprintf("timestamp:%d\tfile:%s\tversion:%s", time.Now().Unix(), filepath.Base(file), version)
		text := reader.SignWithComments(key, comment, "signature from ARC transition signing key")
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return err
		}
		if err := verifyTauri(f, text, pub, version); err != nil {
			return err
		}
		return os.WriteFile(file+".sig", []byte(base64.StdEncoding.EncodeToString(text)+"\n"), 0644)
	}
	raw, err := os.ReadFile(file + ".sig")
	if err != nil {
		return err
	}
	text, err := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw)))
	if err != nil {
		return err
	}
	return verifyTauri(f, text, pub, version)
}

func verifyTauri(file io.Reader, text []byte, public minisign.PublicKey, version string) error {
	var signature minisign.Signature
	if err := signature.UnmarshalText(text); err != nil {
		return err
	}
	var valid bool
	if signature.Algorithm == minisign.HashEdDSA {
		reader := minisign.NewReader(file)
		if _, err := io.Copy(io.Discard, reader); err != nil {
			return err
		}
		valid = reader.Verify(public, text)
	} else {
		bytes, err := io.ReadAll(file)
		if err != nil {
			return err
		}
		valid = minisign.Verify(public, bytes, text)
	}
	if !valid {
		return errors.New("Tauri Minisign signature does not verify")
	}
	for field := range strings.SplitSeq(signature.TrustedComment, "\t") {
		if signedVersion, found := strings.CutPrefix(field, "version:"); found && signedVersion != version {
			return errors.New("Tauri Minisign signature announces a different version")
		}
	}
	return nil
}

func archiveDigest(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return nil, err
	}
	return digest.Sum(nil), nil
}

func generateKeys(directory string) error {
	if !filepath.IsAbs(directory) {
		return errors.New("Rehearsal keys require a new absolute evidence directory")
	}
	if err := os.Mkdir(directory, 0700); err != nil {
		return err
	}
	tauriPub, tauriKey, err := minisign.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	public, _ := tauriPub.MarshalText()
	private, _ := tauriKey.MarshalText()
	mygoPub, mygoKey, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		return err
	}
	for name, data := range map[string][]byte{"tauri.pub": public, "tauri.key": private, "mygo.pub": mygoPub, "mygo.key": mygoKey} {
		if err := os.WriteFile(filepath.Join(directory, name), []byte(base64.StdEncoding.EncodeToString(data)+"\n"), 0600); err != nil {
			return err
		}
	}
	return nil
}
