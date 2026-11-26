// Command brand-icons derives platform raster assets from the canonical PNG.
package main

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"

	"golang.org/x/image/draw"
)

func main() {
	if len(os.Args) != 3 {
		fmt.Fprintln(os.Stderr, "Usage: brand-icons SOURCE.png OUTPUT-DIR")
		os.Exit(2)
	}
	if err := generate(os.Args[1], os.Args[2]); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func generate(source, destination string) error {
	file, err := os.Open(source)
	if err != nil {
		return err
	}
	defer file.Close()
	icon, err := png.Decode(file)
	if err != nil {
		return err
	}
	sizes := map[string]int{
		"icon.png": 512, "64x64.png": 64, "128x128.png": 128, "128x128@2x.png": 256,
		"Square107x107Logo.png": 107, "Square142x142Logo.png": 142, "Square150x150Logo.png": 150,
		"Square284x284Logo.png": 284, "Square310x310Logo.png": 310, "Square44x44Logo.png": 44,
		"Square71x71Logo.png": 71, "Square89x89Logo.png": 89, "StoreLogo.png": 50,
	}
	for name, size := range sizes {
		output := image.NewNRGBA(image.Rect(0, 0, size, size))
		draw.CatmullRom.Scale(output, output.Bounds(), icon, icon.Bounds(), draw.Src, nil)
		f, err := os.Create(filepath.Join(destination, name))
		if err != nil {
			return err
		}
		err = png.Encode(f, output)
		closeErr := f.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
	}
	return nil
}
