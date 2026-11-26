package main

import (
	"errors"
	"sync"
	"sync/atomic"
	"unsafe"

	"github.com/ebitengine/purego"
	"github.com/ebitengine/purego/objc"
	"github.com/egoist/mygo"
	mygoui "github.com/egoist/mygo/ui"
	"github.com/google/uuid"
	"github.com/whzxc/agent-remote-control/internal/core"
)

type cocoaPoint struct{ X, Y float64 }
type cocoaSize struct{ Width, Height float64 }
type cocoaRect struct {
	Origin cocoaPoint
	Size   cocoaSize
}

func nsString(value string) objc.ID {
	return cocoaClass("NSString").Send(objc.RegisterName("stringWithUTF8String:"), value)
}

func nsBytes(value []byte) objc.ID {
	allocated := cocoaClass("NSString").Send(objc.RegisterName("alloc"))
	text := allocated.Send(objc.RegisterName("initWithBytes:length:encoding:"), unsafe.SliceData(value), uint(len(value)), uint(4))
	return text.Send(objc.RegisterName("autorelease"))
}

func cocoaText(value objc.ID) string {
	if value == 0 {
		return ""
	}
	return objc.Send[string](value, objc.RegisterName("UTF8String"))
}

func cocoaURL(value objc.ID) string {
	return cocoaText(value.Send(objc.RegisterName("absoluteString")))
}

const sourceSafariUA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/27.0.1 Safari/605.1.15"

type cocoaDecisionBlock struct {
	isa             uintptr
	flags, reserved uint32
	invoke          uintptr
}

func navigationDecision(block *cocoaDecisionBlock, policy int) {
	var call func(*cocoaDecisionBlock, int)
	purego.RegisterFunc(&call, block.invoke)
	call(block, policy)
}

var sourceViewCallbacks = map[objc.ID]*nativeSourceView{} // AppKit thread
var sourceDelegateClass = sync.OnceValues(func() (objc.Class, error) {
	method := func(name string, f any) objc.MethodDef { return objc.MethodDef{Cmd: objc.RegisterName(name), Fn: f} }
	return objc.RegisterClass("ARCSourceWebViewDelegate", objc.GetClass("NSObject"), nil, nil, []objc.MethodDef{
		method("webView:decidePolicyForNavigationAction:decisionHandler:", func(_ objc.ID, _ objc.SEL, _ objc.ID, action objc.ID, handler *cocoaDecisionBlock) {
			raw := cocoaURL(action.Send(objc.RegisterName("request")).Send(objc.RegisterName("URL")))
			if action.Send(objc.RegisterName("targetFrame")) != 0 && (raw == "about:blank" || core.DesktopSourceAllowed(raw)) {
				navigationDecision(handler, 1)
			} else {
				navigationDecision(handler, 0)
			}
		}),
		method("webView:createWebViewWithConfiguration:forNavigationAction:windowFeatures:", func(_ objc.ID, _ objc.SEL, _, _, _, _ objc.ID) objc.ID { return 0 }),
		method("webView:didStartProvisionalNavigation:", func(self objc.ID, _ objc.SEL, _, _ objc.ID) {
			if source := sourceViewCallbacks[self]; source != nil {
				source.finished = false
			}
		}),
		method("webView:didFinishNavigation:", func(self objc.ID, _ objc.SEL, _, _ objc.ID) {
			if source := sourceViewCallbacks[self]; source != nil {
				source.finished = true
			}
		}),
	})
})

type nativeSourceView struct {
	web, delegate objc.ID
	finished      bool
}

func keepStoreID(store string) objc.ID {
	if _, err := uuid.Parse(store); err != nil {
		return 0
	}
	return cocoaClass("NSUUID").Send(objc.RegisterName("alloc")).Send(objc.RegisterName("initWithUUIDString:"), nsString(store))
}

func createSourceView(host *mygo.Window, id string, safari bool) (*nativeSourceView, error) {
	defer cocoaPool()()
	storeID := keepStoreID(id)
	if storeID == 0 {
		return nil, errors.New("SRC_STORE_ID_INVALID")
	}
	defer storeID.Send(objc.RegisterName("release"))
	cls, err := sourceDelegateClass()
	if err != nil {
		return nil, errors.New("SRC_WEBVIEW_FAILED")
	}
	root := objc.ID(host.NativeHandle()).Send(objc.RegisterName("contentView"))
	bounds := objc.Send[cocoaRect](root, objc.RegisterName("bounds"))
	config := cocoaClass("WKWebViewConfiguration").Send(objc.RegisterName("new"))
	defer config.Send(objc.RegisterName("release"))
	store := cocoaClass("WKWebsiteDataStore").Send(objc.RegisterName("dataStoreForIdentifier:"), storeID)
	if store == 0 {
		return nil, errors.New("SRC_WEBVIEW_FAILED")
	}
	config.Send(objc.RegisterName("setWebsiteDataStore:"), store)
	scripts := config.Send(objc.RegisterName("userContentController")).Send(objc.RegisterName("userScripts"))
	if objc.Send[uint](scripts, objc.RegisterName("count")) != 0 {
		return nil, errors.New("SRC_UNEXPECTED_USER_SCRIPTS")
	}
	web := cocoaClass("WKWebView").Send(objc.RegisterName("alloc")).Send(objc.RegisterName("initWithFrame:configuration:"), bounds, config)
	if web == 0 {
		return nil, errors.New("SRC_WEBVIEW_FAILED")
	}
	delegate := objc.ID(cls).Send(objc.RegisterName("new"))
	view := &nativeSourceView{web: web, delegate: delegate}
	sourceViewCallbacks[delegate] = view
	web.Send(objc.RegisterName("setNavigationDelegate:"), delegate)
	web.Send(objc.RegisterName("setUIDelegate:"), delegate)
	web.Send(objc.RegisterName("setAutoresizingMask:"), uint(2|16)) // NSViewWidthSizable | NSViewHeightSizable
	if safari {
		web.Send(objc.RegisterName("setCustomUserAgent:"), nsString(sourceSafariUA))
	}
	root.Send(objc.RegisterName("addSubview:"), web)
	return view, nil
}

func newSourceWindow(title string) *mygo.Window {
	return mygo.NewWindow(mygo.WindowOptions{
		Title: title, Width: 1100, Height: 800, UseContentSize: true,
		Content: mygoui.View(func(*mygoui.Context) {}),
	})
}

func (v *nativeSourceView) close() {
	if v.web == 0 {
		return
	}
	defer cocoaPool()()
	delete(sourceViewCallbacks, v.delegate)
	v.web.Send(objc.RegisterName("setNavigationDelegate:"), objc.ID(0))
	v.web.Send(objc.RegisterName("setUIDelegate:"), objc.ID(0))
	v.web.Send(objc.RegisterName("stopLoading"))
	v.web.Send(objc.RegisterName("removeFromSuperview"))
	v.web.Send(objc.RegisterName("release"))
	v.delegate.Send(objc.RegisterName("release"))
	v.web, v.delegate = 0, 0
}

func (v *nativeSourceView) currentURL() string {
	defer cocoaPool()()
	return cocoaURL(v.web.Send(objc.RegisterName("URL")))
}

func (v *nativeSourceView) navigate(url string) error {
	defer cocoaPool()()
	v.finished = false
	target := cocoaClass("NSURL").Send(objc.RegisterName("URLWithString:"), nsString(url))
	request := cocoaClass("NSURLRequest").Send(objc.RegisterName("requestWithURL:"), target)
	if v.web.Send(objc.RegisterName("loadRequest:"), request) == 0 {
		return errors.New("SRC_NAVIGATION_FAILED")
	}
	return nil
}

func (v *nativeSourceView) installCookies(cookies []chromeCookie) (<-chan struct{}, error) {
	defer cocoaPool()()
	store := v.web.Send(objc.RegisterName("configuration")).Send(objc.RegisterName("websiteDataStore")).Send(objc.RegisterName("httpCookieStore"))
	prepared := make([]objc.ID, 0, len(cookies))
	for _, cookie := range cookies {
		dictionary := cocoaClass("NSMutableDictionary").Send(objc.RegisterName("dictionary"))
		set := func(key string, value objc.ID) {
			dictionary.Send(objc.RegisterName("setObject:forKey:"), value, nsString(key))
		}
		value := nsBytes(cookie.value)
		if value == 0 {
			return nil, errors.New("native-cookie-invalid")
		}
		set("Name", nsString(cookie.name))
		set("Value", value)
		set("Path", nsString(cookie.path))
		set("Domain", nsString(cookie.host))
		if cookie.secure {
			set("Secure", nsString("TRUE"))
		}
		if cookie.httpOnly {
			set("HttpOnly", nsString("TRUE"))
		}
		if cookie.persistent {
			set("Expires", cocoaClass("NSDate").Send(objc.RegisterName("dateWithTimeIntervalSince1970:"), float64(cookie.expires)))
		}
		sameSite := ""
		switch cookie.sameSite {
		case 1:
			sameSite = "lax"
		case 2:
			sameSite = "strict"
		}
		if sameSite != "" {
			set("SameSite", nsString(sameSite))
		}
		native := cocoaClass("NSHTTPCookie").Send(objc.RegisterName("cookieWithProperties:"), dictionary)
		if native == 0 {
			return nil, errors.New("native-cookie-invalid")
		}
		if cocoaText(native.Send(objc.RegisterName("name"))) != cookie.name ||
			cocoaText(native.Send(objc.RegisterName("domain"))) != cookie.host ||
			cocoaText(native.Send(objc.RegisterName("path"))) != cookie.path ||
			objc.Send[bool](native, objc.RegisterName("isSecure")) != cookie.secure ||
			objc.Send[bool](native, objc.RegisterName("isHTTPOnly")) != cookie.httpOnly ||
			cocoaText(native.Send(objc.RegisterName("sameSitePolicy"))) != sameSite {
			return nil, errors.New("native-cookie-metadata-mismatch")
		}
		prepared = append(prepared, native)
	}
	var remaining atomic.Int64
	remaining.Store(int64(len(prepared)))
	done := make(chan struct{})
	if len(prepared) == 0 {
		close(done)
	}
	for _, cookie := range prepared {
		callback := objc.NewBlock(func(_ objc.Block) {
			if remaining.Add(-1) == 0 {
				close(done)
			}
		})
		store.Send(objc.RegisterName("setCookie:completionHandler:"), cookie, callback)
		callback.Release()
	}
	return done, nil
}

type sourceRemoval struct {
	done chan struct{}
	err  error
}

func removeSourceStore(id string) (*sourceRemoval, error) {
	defer cocoaPool()()
	storeID := keepStoreID(id)
	if storeID == 0 {
		return nil, errors.New("SRC_STORE_ID_INVALID")
	}
	defer storeID.Send(objc.RegisterName("release"))
	removal := &sourceRemoval{done: make(chan struct{})}
	callback := objc.NewBlock(func(_ objc.Block, nativeError objc.ID) {
		if nativeError != 0 {
			removal.err = errors.New("SRC_STORE_CLEAR_FAILED: Native website data removal failed; retry clear before importing")
		}
		close(removal.done)
	})
	defer callback.Release()
	cocoaClass("WKWebsiteDataStore").Send(objc.RegisterName("removeDataStoreForIdentifier:completionHandler:"), storeID, callback)
	return removal, nil
}
