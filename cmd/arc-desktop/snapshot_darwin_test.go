package main

import (
	"bytes"
	"image"
	"image/color"
	"image/png"
	"runtime"
	"testing"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
)

func TestPNGEncodingReleasesAppKitBuffersBeforeReturning(t *testing.T) {
	// Recurring bug class: lifecycle native PNG data must be copied out of its callback pool.
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	const width, height = 1680, 1156
	source := image.NewUniform(color.White)
	var data bytes.Buffer
	if err := png.Encode(&data, sourceSubimage{source, image.Rect(0, 0, width, height)}); err != nil {
		t.Fatal(err)
	}
	appKit, err := purego.Dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", purego.RTLD_NOW|purego.RTLD_LOCAL)
	if err != nil {
		t.Fatal(err)
	}
	defer purego.Dlclose(appKit)
	defer cocoaPool()()
	nativeData := cocoaClass("NSData").Send(objc.RegisterName("dataWithBytes:length:"), unsafe.SliceData(data.Bytes()), uint(data.Len()))
	for i := 0; i < 30; i++ {
		input := cocoaClass("NSImage").Send(objc.RegisterName("alloc")).Send(objc.RegisterName("initWithData:"), nativeData)
		if input == 0 {
			t.Fatal("AppKit rejected synthetic input image")
		}
		weak := cocoaClass("NSPointerArray").Send(objc.RegisterName("weakObjectsPointerArray"))
		add, pointerAt := objc.RegisterName("addPointer:"), objc.RegisterName("pointerAtIndex:")
		weak.Send(add, uintptr(input))
		encoded, err := encodePNG(input, func(tiff, bitmap, data objc.ID) {
			for _, object := range []objc.ID{tiff, bitmap, data} {
				weak.Send(add, uintptr(object))
			}
		})
		size := objc.Send[cocoaSize](input, objc.RegisterName("size"))
		func() {
			defer input.Send(objc.RegisterName("release"))
			if count := objc.Send[uint](weak, objc.RegisterName("count")); count != 4 {
				t.Fatalf("native encoder observed %d of 4 objects", count)
			}
			for index, kind := range []string{"TIFF", "bitmap", "PNG data"} {
				if address := objc.Send[uintptr](weak, pointerAt, uint(index+1)); address != 0 {
					t.Errorf("native %s survived the encoder autorelease pool", kind)
				}
			}
		}()
		if address := objc.Send[uintptr](weak, pointerAt, uint(0)); address != 0 {
			t.Fatal("encoder retained its borrowed input image")
		}
		if err != nil {
			t.Fatal(err)
		}
		result, err := png.DecodeConfig(bytes.NewReader(encoded))
		if err != nil || result.Width != width || result.Height != height || size.Width <= 0 || size.Height <= 0 {
			t.Fatalf("native capture lost image dimensions or ownership: %v, %v, %v", result, size, err)
		}
	}
}

type sourceSubimage struct {
	image.Image
	rect image.Rectangle
}

func (s sourceSubimage) Bounds() image.Rectangle { return s.rect }

func TestAbandonedCaptureHoldsCapacityUntilNativeCompletion(t *testing.T) {
	// Recurring bug class: concurrency an abandoned snapshot does not release native capture capacity early.
	complete, err := beginPNG()
	if err != nil {
		t.Fatal(err)
	}
	defer complete()
	callback, err := pngCallback(complete, func(_, _ objc.ID) {})
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 120; i++ {
		if release, err := beginPNG(); err == nil {
			release()
			t.Fatal("native capture capacity was released before callback completion")
		}
	}
	callback.Invoke(objc.ID(0), objc.ID(0))
	later, err := beginPNG()
	if err != nil {
		t.Fatal(err)
	}
	defer later()
	callback.Release()
	if release, err := beginPNG(); err == nil {
		release()
		t.Fatal("a retained callback released a newer capture")
	}
	discarded, err := pngCallback(later, func(_, _ objc.ID) {})
	if err != nil {
		t.Fatal(err)
	}
	discarded.Release()
	release, err := beginPNG()
	if err != nil {
		t.Fatal("disposing an uninvoked native block must free capacity:", err)
	}
	release()
}
