package main

import (
	"context"
	"errors"
	"sync"
	"time"
	"unsafe"

	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
)

type pngResult struct {
	data []byte
	err  error
}

var pngCapture = make(chan struct{}, 1)

func beginPNG() (func(), error) {
	select {
	case pngCapture <- struct{}{}:
		return sync.OnceFunc(func() { <-pngCapture }), nil
	default:
		return nil, errors.New("SNAPSHOT_BUSY: a WebView PNG capture is still in flight")
	}
}

func cocoaClass(name string) objc.ID { return objc.ID(objc.GetClass(name)) }

func cocoaPool() func() {
	pool := cocoaClass("NSAutoreleasePool").Send(objc.RegisterName("new"))
	return func() { pool.Send(objc.RegisterName("drain")) }
}

func findWebView(view objc.ID) objc.ID {
	if objc.Send[bool](view, objc.RegisterName("isKindOfClass:"), cocoaClass("WKWebView")) {
		return view
	}
	views := view.Send(objc.RegisterName("subviews"))
	for i, count := uint(0), objc.Send[uint](views, objc.RegisterName("count")); i < count; i++ {
		if child := findWebView(views.Send(objc.RegisterName("objectAtIndex:"), i)); child != 0 {
			return child
		}
	}
	return 0
}

func capturePNG(ctx context.Context, window *mygo.Window) ([]byte, error) {
	release, err := beginPNG()
	if err != nil {
		return nil, err
	}
	result := make(chan pngResult, 1)
	// Once queued, native completion owns the permit, including after timeout.
	wait, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	go mygo.RunOnMain(func() {
		if wait.Err() != nil {
			release()
			return
		}
		defer cocoaPool()()
		view := findWebView(objc.ID(window.NativeHandle()).Send(objc.RegisterName("contentView")))
		if view == 0 {
			release()
			result <- pngResult{err: errors.New("main WebView unavailable")}
			return
		}
		off := window.OnClosed(release)
		callback := objc.NewBlock(func(_ objc.Block, image, nativeError objc.ID) {
			defer release()
			defer off()
			if image == 0 || nativeError != 0 {
				result <- pngResult{err: errors.New("WKWebView takeSnapshot failed")}
				return
			}
			data, err := encodePNG(image)
			result <- pngResult{data, err}
		})
		defer callback.Release()
		view.Send(objc.RegisterName("takeSnapshotWithConfiguration:completionHandler:"), objc.ID(0), callback)
	})
	select {
	case r := <-result:
		return r.data, r.err
	case <-wait.Done():
		return nil, errors.New("SNAPSHOT_TIMEOUT: WKWebView")
	}
}

func encodePNG(image objc.ID) ([]byte, error) {
	defer cocoaPool()()
	tiff := image.Send(objc.RegisterName("TIFFRepresentation"))
	if tiff == 0 {
		return nil, errors.New("snapshot TIFF unavailable")
	}
	bitmap := cocoaClass("NSBitmapImageRep").Send(objc.RegisterName("imageRepWithData:"), tiff)
	if bitmap == 0 {
		return nil, errors.New("snapshot bitmap unavailable")
	}
	properties := cocoaClass("NSDictionary").Send(objc.RegisterName("dictionary"))
	data := bitmap.Send(objc.RegisterName("representationUsingType:properties:"), uint(4), properties)
	if data == 0 {
		return nil, errors.New("snapshot PNG encoding failed")
	}
	length := objc.Send[int](data, objc.RegisterName("length"))
	ptr := objc.Send[unsafe.Pointer](data, objc.RegisterName("bytes"))
	if ptr == nil || length <= 0 {
		return nil, errors.New("snapshot PNG bytes unavailable")
	}
	return append([]byte(nil), unsafe.Slice((*byte)(ptr), length)...), nil
}
