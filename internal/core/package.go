package core

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"slices"
	"strings"

	"github.com/whzxc/agent-remote-control/internal/canonjson"
	"github.com/whzxc/agent-remote-control/skills"
)

const packageIdentifier = "com.whzxc.agent-remote-control"
const packageDevIdentifier = packageIdentifier + ".dev"
const packageCertificate = "dce238666578502cf7de81a7b4d5e835a186bc60"

func packageIdentifierAllowed(identifier string, instance *string) bool {
	if instance == nil {
		return identifier == packageIdentifier || identifier == packageDevIdentifier
	}
	if len(*instance) < 8 || len(*instance) > 32 {
		return false
	}
	for _, letter := range *instance {
		if !(letter >= 'a' && letter <= 'z' || letter >= '0' && letter <= '9') {
			return false
		}
	}
	return identifier == packageDevIdentifier+".acceptance-"+*instance
}

func packagePlist(ctx context.Context, app, key string) (string, error) {
	value, err := commandOutput(ctx, "/usr/libexec/PlistBuddy", "-c", "Print :"+key, filepath.Join(app, "Contents/Info.plist"))
	return strings.TrimSpace(value), err
}

func packageSignature(ctx context.Context, app, identifier string) error {
	var instance *string
	marker := filepath.Join(root(), "acceptance-instance.json")
	if _, err := os.Stat(marker); err == nil {
		value, err := load(marker)
		if err != nil {
			return err
		}
		selected := text(value, "instanceId")
		instance = &selected
	}
	if !packageIdentifierAllowed(identifier, instance) {
		return errors.New("INVALID_PACKAGE: unsupported bundle identifier")
	}
	for _, artifact := range []struct{ path, suffix string }{
		{app, ""},
		{filepath.Join(app, "Contents/Resources/bin/arc"), ".core"},
		{filepath.Join(app, "Contents/Resources/bin/arc-screen"), ".screen"},
	} {
		args := []string{"--verify", "--strict"}
		if identifier == packageIdentifier {
			args = append(args, "-R", fmt.Sprintf(`=identifier "%s%s" and certificate leaf = H"%s"`, identifier, artifact.suffix, packageCertificate))
		}
		if _, err := commandOutput(ctx, "/usr/bin/codesign", append(args, artifact.path)...); err != nil {
			return err
		}
	}
	return nil
}

func inspectPackage(path string) error {
	entries, err := os.ReadDir(path)
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if slices.Contains([]string{"node_modules", "runtime", "node", "node.exe", "npm", "npx", "desktop-launch.mjs"}, entry.Name()) {
			return errors.New("INVALID_PACKAGE: legacy runtime resource")
		}
		if !entry.IsDir() && !entry.Type().IsRegular() {
			return errors.New("INVALID_PACKAGE: links and special files are not supported")
		}
		if entry.IsDir() {
			if err := inspectPackage(filepath.Join(path, entry.Name())); err != nil {
				return err
			}
		}
	}
	return nil
}

func checkPackage(ctx context.Context, app string) (object, error) {
	if filepath.Ext(app) != ".app" {
		return nil, errors.New("INVALID_PACKAGE: expected .app")
	}
	if err := inspectPackage(app); err != nil {
		return nil, err
	}
	identifier, err := packagePlist(ctx, app, "CFBundleIdentifier")
	if err != nil {
		return nil, err
	}
	if err := packageSignature(ctx, app, identifier); err != nil {
		return nil, err
	}
	resources := filepath.Join(app, "Contents/Resources")
	core := filepath.Join(resources, "bin/arc")
	desktop := filepath.Join(app, "Contents/MacOS/agent-remote-control-desktop")
	version, err := packagePlist(ctx, app, "CFBundleShortVersionString")
	if err != nil {
		return nil, err
	}
	if version != buildVersion {
		return nil, errors.New("INVALID_PACKAGE: Desktop and Core versions differ")
	}
	coreVersion, err := commandOutput(ctx, core, "--version")
	if err != nil {
		return nil, err
	}
	if strings.TrimSpace(coreVersion) != version {
		return nil, errors.New("INVALID_PACKAGE: Desktop and Core versions differ")
	}
	executable, err := packagePlist(ctx, app, "CFBundleExecutable")
	if err != nil {
		return nil, err
	}
	if executable != "agent-remote-control-desktop" || !skillFile(desktop) {
		return nil, errors.New("INVALID_PACKAGE: missing Desktop executable")
	}
	err = fs.WalkDir(skills.PackageAssets, "arc-setup", func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		actual, err := os.ReadFile(filepath.Join(resources, "skills", filepath.FromSlash(path)))
		if err != nil {
			return err
		}
		expected, err := skills.PackageAssets.ReadFile(path)
		if err != nil {
			return err
		}
		if !bytes.Equal(actual, expected) {
			return fmt.Errorf("INVALID_PACKAGE: skill resource differs: %s", strings.TrimPrefix(path, "arc-setup/"))
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	name, err := packagePlist(ctx, app, "CFBundleIconName")
	if err != nil {
		return nil, err
	}
	if strings.Contains(name, "/") {
		return nil, errors.New("INVALID_PACKAGE: invalid icon name")
	}
	icon, err := packagePlist(ctx, app, "CFBundleIconFile")
	if err != nil {
		return nil, err
	}
	if name != icon || !skillFile(filepath.Join(resources, name+".icns")) {
		return nil, errors.New("INVALID_PACKAGE: invalid icon name")
	}
	json, err := commandOutput(ctx, "/usr/bin/xcrun", "assetutil", "--info", filepath.Join(resources, "Assets.car"))
	if err != nil {
		return nil, err
	}
	var assets any
	if err := canonjson.Unmarshal([]byte(json), &assets); err != nil {
		return nil, err
	}
	rows, ok := assets.([]any)
	if !ok {
		return nil, errors.New("INVALID_PACKAGE: invalid icon assets")
	}
	var image, light, dark bool
	for _, row := range rows {
		if text(row, "Name") != name {
			continue
		}
		switch text(row, "AssetType") {
		case "Icon Image":
			image = true
		case "IconImageStack":
			light = light || text(row, "Appearance") == "NSAppearanceNameAqua"
			dark = dark || text(row, "Appearance") == "NSAppearanceNameDarkAqua"
		}
	}
	if !image || !light || !dark {
		return nil, errors.New("INVALID_PACKAGE: missing native icon appearance")
	}
	coreBuild, err := buildID(core)
	if err != nil {
		return nil, err
	}
	desktopBuild, err := buildID(desktop)
	if err != nil {
		return nil, err
	}
	return object{"identifier": identifier, "version": version, "coreBuild": coreBuild, "desktopBuild": desktopBuild}, nil
}
