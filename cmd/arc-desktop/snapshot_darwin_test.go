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
		encoded, err := encodePNG(input)
		size := objc.Send[cocoaSize](input, objc.RegisterName("size"))
		input.Send(objc.RegisterName("release"))
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
	for i := 0; i < 120; i++ {
		if release, err := beginPNG(); err == nil {
			release()
			t.Fatal("native capture capacity was released before callback completion")
		}
	}
	complete()
	later, err := beginPNG()
	if err != nil {
		t.Fatal(err)
	}
	defer later()
	complete()
	if release, err := beginPNG(); err == nil {
		release()
		t.Fatal("a retained callback released a newer capture")
	}
}
