import AppKit
import ApplicationServices

// AX does not expose a public window-number attribute. Map an AX window to its
// WindowServer ID instead of guessing from titles shared by multiple windows.
@_silgen_name("_AXUIElementGetWindow")
func AXWindowID(_ element: AXUIElement, _ id: UnsafeMutablePointer<CGWindowID>) -> AXError

struct Failure: Error { let message: String }
// AppKit activation state changes are delivered on the main run loop.
func pause(_ seconds: Double) {
    let deadline = Date().addingTimeInterval(seconds)
    while Date() < deadline {
        let slice = min(0.02, deadline.timeIntervalSinceNow)
        if slice > 0 && !RunLoop.current.run(mode: .default, before: Date().addingTimeInterval(slice)) {
            Thread.sleep(forTimeInterval: slice)
        }
    }
}
func fail(_ message: String) throws -> Never { throw Failure(message: message) }
func attribute(_ element: AXUIElement, _ name: String) -> AnyObject? {
    var value: AnyObject?
    AXUIElementCopyAttributeValue(element, name as CFString, &value)
    return value
}
func string(_ element: AXUIElement, _ name: String) -> String {
    let value = attribute(element, name)
    if let value = value as? String { return value }
    if let value = value as? NSNumber { return value.stringValue }
    return ""
}
func frame(_ element: AXUIElement) -> CGRect? {
    guard let position = attribute(element, kAXPositionAttribute),
          let size = attribute(element, kAXSizeAttribute),
          CFGetTypeID(position) == AXValueGetTypeID(), CFGetTypeID(size) == AXValueGetTypeID() else { return nil }
    var point = CGPoint.zero, extent = CGSize.zero
    guard AXValueGetValue(position as! AXValue, .cgPoint, &point),
          AXValueGetValue(size as! AXValue, .cgSize, &extent) else { return nil }
    return CGRect(origin: point, size: extent)
}
func rectJSON(_ rect: CGRect) -> [String: Any] {
    ["x": rect.origin.x, "y": rect.origin.y, "width": rect.width, "height": rect.height]
}
func requireAX() throws {
    if !AXIsProcessTrusted() { try fail("PERMISSION_REQUIRED:accessibility") }
}
func requireRecording() throws {
    if !CGPreflightScreenCaptureAccess() { try fail("PERMISSION_REQUIRED:screen-recording") }
}
struct Window {
    let id: CGWindowID
    let app: NSRunningApplication
    let title: String
    let bounds: CGRect
    let onScreen: Bool
    var json: [String: Any] {
        ["windowId": id, "app": app.localizedName ?? "", "bundleId": app.bundleIdentifier ?? "",
         "pid": app.processIdentifier, "title": title, "frame": rectJSON(bounds),
         "onScreen": onScreen, "frontmost": isFront(self), "appActive": app.isActive]
    }
}
func windows(_ args: [String: Any]) -> [Window] {
    let rows = CGWindowListCopyWindowInfo(.optionAll, kCGNullWindowID) as? [[String: Any]] ?? []
    return rows.compactMap { row in
        guard (row[kCGWindowLayer as String] as? Int) == 0,
              let pid = row[kCGWindowOwnerPID as String] as? Int32,
              let app = NSRunningApplication(processIdentifier: pid),
              let id = row[kCGWindowNumber as String] as? UInt32,
              let bounds = row[kCGWindowBounds as String] as? [String: CGFloat] else { return nil }
        let title = row[kCGWindowName as String] as? String ?? ""
        let rect = CGRect(x: bounds["X"] ?? 0, y: bounds["Y"] ?? 0, width: bounds["Width"] ?? 0, height: bounds["Height"] ?? 0)
        guard rect.width > 1 && rect.height > 1 else { return nil }
        if let name = args["app"] as? String, !(app.localizedName ?? "").localizedCaseInsensitiveContains(name) { return nil }
        if let bundle = args["bundleId"] as? String, app.bundleIdentifier != bundle { return nil }
        if let text = args["title"] as? String, !title.localizedCaseInsensitiveContains(text) { return nil }
        if let number = args["windowId"] as? UInt32, id != number { return nil }
        return Window(id: id, app: app, title: title, bounds: rect, onScreen: row[kCGWindowIsOnscreen as String] as? Bool ?? false)
    }
}
func windowID(_ element: AXUIElement) -> CGWindowID {
    var id: CGWindowID = 0
    _ = AXWindowID(element, &id)
    return id
}
func root(_ app: NSRunningApplication) -> AXUIElement {
    let root = AXUIElementCreateApplication(app.processIdentifier)
    AXUIElementSetMessagingTimeout(root, 1)
    return root
}
func target(_ args: [String: Any]) throws -> Window {
    guard ["app", "bundleId", "title", "windowId"].contains(where: { args[$0] != nil }) else {
        try fail("SCREEN_TARGET_REQUIRED: 指定 app、bundleId、title 或 windowId。")
    }
    if args["title"] != nil { try requireRecording() }
    let matches = windows(args)
    guard let first = matches.first else { try fail("WINDOW_NOT_FOUND") }
    let apps = Set(matches.map { $0.app.processIdentifier })
    let app = matches.first(where: { $0.app.isActive })?.app ?? first.app
    if apps.count > 1 && !app.isActive { try fail("AMBIGUOUS_APP: 请指定 bundleId 或 windowId。") }
    let candidates = matches.filter { $0.app.processIdentifier == app.processIdentifier }
    if candidates.count > 1 && AXIsProcessTrusted(),
       let main = attribute(root(app), kAXMainWindowAttribute) {
        let id = windowID(main as! AXUIElement)
        if let match = candidates.first(where: { $0.id == id }) { return match }
    }
    return candidates.first(where: { $0.onScreen }) ?? candidates[0]
}
func axWindow(_ window: Window) throws -> AXUIElement {
    try requireAX()
    let app = root(window.app)
    AXUIElementSetAttributeValue(app, "AXEnhancedUserInterface" as CFString, kCFBooleanTrue)
    AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    pause(0.3)
    let rows = attribute(app, kAXWindowsAttribute) as? [AXUIElement] ?? []
    guard let found = rows.first(where: { windowID($0) == window.id }) else { try fail("AX_WINDOW_NOT_FOUND") }
    return found
}
func isFront(_ window: Window) -> Bool {
    guard window.app.isActive else { return false }
    if AXIsProcessTrusted(), let focused = attribute(root(window.app), kAXFocusedWindowAttribute) {
        return windowID(focused as! AXUIElement) == window.id
    }
    return windows([:]).first(where: { $0.onScreen })?.id == window.id
}
func raise(_ window: Window) throws {
    let element = try axWindow(window)
    if (attribute(element, kAXMinimizedAttribute) as? Bool) == true {
        AXUIElementSetAttributeValue(element, kAXMinimizedAttribute as CFString, kCFBooleanFalse)
    }
    let result = AXUIElementPerformAction(element, kAXRaiseAction as CFString)
    if result != .success {
        AXUIElementSetAttributeValue(element, kAXMainAttribute as CFString, kCFBooleanTrue)
    }
    guard window.app.activate(options: []) else { try fail("APP_ACTIVATION_FAILED") }
    for _ in 0..<20 {
        pause(0.05)
        if isFront(window) { return }
    }
    try fail("WINDOW_NOT_FRONTMOST: AXRaise=\(result.rawValue)")
}
final class Focus {
    var restoreApp: NSRunningApplication?
    var restoreWindow: AXUIElement?
    func prepare(_ window: Window, mode: String, required: Bool) throws -> Bool {
        if isFront(window) { return false }
        // kCGAnyInputEventType is not a Swift enum case.
        let idleSeconds = CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: CGEventType(rawValue: ~UInt32(0))!)
        if mode == "never" || (mode == "auto" && idleSeconds < 60) {
            if required { try fail("FOREGROUND_REQUIRED: 目标窗口不在前台；front=never 或用户最近 60 秒内有操作，未抢占前台。") }
            return false
        }
        if mode == "auto" && restoreApp == nil {
            restoreApp = NSWorkspace.shared.frontmostApplication
            if let app = restoreApp, AXIsProcessTrusted(), let focused = attribute(root(app), kAXFocusedWindowAttribute) {
                restoreWindow = (focused as! AXUIElement)
            }
        }
        try raise(window)
        return true
    }
    func restore() {
        if let element = restoreWindow { _ = AXUIElementPerformAction(element, kAXRaiseAction as CFString) }
        if let app = restoreApp {
            _ = app.activate(options: [])
            pause(0.2)
        }
    }
}
struct Entry {
    let element: AXUIElement
    let ref: String
    let role: String
    let label: String
    var json: [String: Any] {
        var value: [String: Any] = ["ref": ref, "role": role, "label": label]
        value["frame"] = frame(element).map(rectJSON) ?? NSNull() as Any
        return value
    }
}
func tree(_ window: Window, text: Bool, limit: Int) throws -> ([Entry], Bool) {
    let start = try axWindow(window)
    var entries: [Entry] = [], visited = 0, truncated = false
    let deadline = Date().addingTimeInterval(10)
    let roles: Set<String> = ["AXButton", "AXCheckBox", "AXRadioButton", "AXPopUpButton", "AXTextField", "AXTextArea", "AXMenuItem", "AXLink", "AXDisclosureTriangle", "AXSlider", "AXIncrementor", "AXComboBox", "AXTab", "AXRow", "AXCell", "AXHeading", "AXWindow"]
    func walk(_ element: AXUIElement, _ path: String, _ depth: Int) {
        if truncated { return }
        if entries.count >= limit || visited >= 5000 || depth > 60 || Date() > deadline { truncated = true; return }
        visited += 1
        let role = string(element, kAXRoleAttribute)
        let parts = [string(element, kAXTitleAttribute), string(element, kAXDescriptionAttribute), string(element, kAXValueAttribute)]
        var seen = Set<String>()
        let label = parts.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: " | ")
        if roles.contains(role) || (role == "AXGroup" && !string(element, kAXDescriptionAttribute).isEmpty) || (text && role == "AXStaticText") {
            entries.append(Entry(element: element, ref: path, role: role, label: String(label.prefix(2000))))
        }
        for (index, child) in (attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []).enumerated() {
            walk(child, "\(path).\(index)", depth + 1)
            if truncated { break }
        }
    }
    walk(start, "\(window.id):0", 0)
    return (entries, truncated)
}
func find(_ args: [String: Any], _ window: Window) throws -> Entry {
    if let ref = args["ref"] as? String {
        let parts = ref.split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count == 2, UInt32(parts[0]) == window.id else { try fail("ELEMENT_REF_WRONG_WINDOW") }
        let path = parts[1].split(separator: ".").compactMap { Int($0) }
        guard path.first == 0, path.count <= 61, path.count == parts[1].split(separator: ".").count else { try fail("INVALID_ELEMENT_REF") }
        var element = try axWindow(window)
        for index in path.dropFirst() {
            let children = attribute(element, kAXChildrenAttribute) as? [AXUIElement] ?? []
            guard index >= 0 && index < children.count else { try fail("ELEMENT_NOT_FOUND: 请重新读取 tree。") }
            element = children[index]
        }
        return Entry(element: element, ref: ref, role: string(element, kAXRoleAttribute), label: string(element, kAXTitleAttribute))
    }
    guard let label = args["label"] as? String, !label.isEmpty else { try fail("ELEMENT_TARGET_REQUIRED: 指定 ref 或 label。") }
    let (entries, truncated) = try tree(window, text: false, limit: 1000)
    let matches = entries.filter { $0.label.localizedCaseInsensitiveContains(label) }
    let nth = args["nth"] as? Int ?? 0
    guard nth >= 0 && nth < matches.count else { try fail("ELEMENT_NOT_FOUND: matches=\(matches.count), truncated=\(truncated)") }
    return matches[nth]
}
func capture(_ window: Window, _ args: [String: Any], _ focus: Focus) throws -> [String: Any] {
    try requireRecording()
    let raised = try focus.prepare(window, mode: args["front"] as? String ?? "auto", required: false)
    if raised { pause(0.2) }
    let stale = !isFront(window)
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent("arc-screen-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
    defer { try? FileManager.default.removeItem(at: directory) }
    let file = directory.appendingPathComponent("capture.png")
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    process.arguments = ["-x", "-o", "-l", String(window.id), file.path]
    let errors = Pipe()
    process.standardOutput = FileHandle.nullDevice
    process.standardError = errors
    try process.run()
    process.waitUntilExit()
    guard process.terminationStatus == 0 else { try fail("WINDOW_CAPTURE_FAILED: \(String(data: errors.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")") }
    let data = try Data(contentsOf: file)
    return ["window": window.json, "possiblyStale": stale, "raised": raised, "imageBase64": data.base64EncodedString()]
}
func key(_ description: String) throws {
    let codes: [String: CGKeyCode] = ["a":0,"s":1,"d":2,"f":3,"h":4,"g":5,"z":6,"x":7,"c":8,"v":9,"b":11,"q":12,"w":13,"e":14,"r":15,"y":16,"t":17,"1":18,"2":19,"3":20,"4":21,"6":22,"5":23,"9":25,"7":26,"8":28,"0":29,"o":31,"u":32,"i":34,"p":35,"return":36,"enter":36,"l":37,"j":38,"k":40,"n":45,"m":46,"tab":48,"space":49,"delete":51,"backspace":51,"escape":53,"esc":53,"left":123,"right":124,"down":125,"up":126,"arrowleft":123,"arrowright":124,"arrowdown":125,"arrowup":126]
    var pieces = description.lowercased().split(separator: "+").map(String.init)
    guard let last = pieces.popLast(), let code = codes[last] else { try fail("UNSUPPORTED_KEY: \(description)") }
    var flags: CGEventFlags = []
    for modifier in pieces {
        switch modifier {
        case "cmd", "command": flags.insert(.maskCommand)
        case "shift": flags.insert(.maskShift)
        case "alt", "option": flags.insert(.maskAlternate)
        case "ctrl", "control": flags.insert(.maskControl)
        default: try fail("UNSUPPORTED_MODIFIER: \(modifier)")
        }
    }
    guard let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true),
          let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false) else { try fail("KEY_EVENT_FAILED") }
    down.flags = flags; up.flags = flags
    down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
    pause(0.1)
}
func run(_ args: [String: Any]) throws -> [String: Any] {
    let action = args["action"] as? String ?? ""
    if action == "status" {
        return ["accessibility": AXIsProcessTrusted() ? "granted" : "missing",
                "screen-recording": CGPreflightScreenCaptureAccess() ? "granted" : "missing"]
    }
    if action == "request" {
        switch args["permissionId"] as? String {
        case "accessibility":
            _ = AXIsProcessTrustedWithOptions([kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary)
        case "screen-recording": _ = CGRequestScreenCaptureAccess()
        default: try fail("UNKNOWN_PERMISSION")
        }
        return ["requested": true]
    }
    guard ["windows", "capture", "tree", "press", "show", "raise", "key"].contains(action) else { try fail("UNKNOWN_SCREEN_ACTION") }
    let mode = args["front"] as? String ?? "auto"
    guard ["auto", "never", "always"].contains(mode) else { try fail("INVALID_FRONT_MODE") }
    if action == "windows" {
        try requireRecording()
        return ["windows": windows(args).map(\.json)]
    }
    if action == "capture" { try requireRecording() }
    if action != "capture" { try requireAX() }
    let window = try target(args)
    let focus = Focus()
    defer { focus.restore() }
    if action == "capture" { return try capture(window, args, focus) }
    try requireAX()
    if action == "tree" {
        let (entries, truncated) = try tree(window, text: args["text"] as? Bool ?? false, limit: min(1000, max(1, args["limit"] as? Int ?? 300)))
        return ["window": window.json, "elements": entries.map(\.json), "truncated": truncated]
    }
    var result: [String: Any] = ["window": window.json, "action": action]
    switch action {
    case "raise": try raise(window)
    case "key":
        _ = try focus.prepare(window, mode: mode, required: true)
        guard isFront(window) else { try fail("FOREGROUND_CHANGED: 未发送按键。") }
        try key(args["key"] as? String ?? "")
    case "press", "show":
        let entry = try find(args, window)
        let status = AXUIElementPerformAction(entry.element, (action == "press" ? kAXPressAction : "AXScrollToVisible") as CFString)
        result["element"] = entry.json
        if status == .success { result["method"] = action == "press" ? "AXPress" : "AXScrollToVisible" }
        else if action == "press" {
            _ = try focus.prepare(window, mode: mode, required: true)
            guard let rect = frame(entry.element), rect.width > 0, rect.height > 0,
                  let currentWindow = frame(try axWindow(window)), currentWindow.contains(CGPoint(x: rect.midX, y: rect.midY)) else { try fail("ELEMENT_NOT_VISIBLE: 请先 show。") }
            let point = CGPoint(x: rect.midX, y: rect.midY)
            guard let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: point, mouseButton: .left),
                  let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left) else { try fail("MOUSE_EVENT_FAILED") }
            guard isFront(window) else { try fail("FOREGROUND_CHANGED: 未发送点击。") }
            down.post(tap: .cghidEventTap); up.post(tap: .cghidEventTap)
            pause(0.1)
            result["method"] = "CGEvent"
        } else { try fail("AX_SCROLL_TO_VISIBLE_FAILED: \(status.rawValue)") }
    default: break
    }
    result["performed"] = true
    result["window"] = window.json
    if let after = args["after"] as? [String: Any] {
        pause(Double(min(10000, max(0, after["waitMs"] as? Int ?? 200))) / 1000)
        if (after["capture"] as? Bool) == true || after["capture"] is [String: Any] {
            var options = after["capture"] as? [String: Any] ?? [:]
            if options["front"] == nil { options["front"] = mode }
            do { result["capture"] = try capture(window, options, focus) }
            catch { result["captureError"] = (error as? Failure)?.message ?? error.localizedDescription }
        }
    }
    return result
}
do {
    let data = FileHandle.standardInput.readDataToEndOfFile()
    guard let args = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { try fail("INVALID_JSON_OBJECT") }
    let result = try run(args)
    let response = try JSONSerialization.data(withJSONObject: ["ok": true, "result": result], options: [.sortedKeys])
    FileHandle.standardOutput.write(response)
} catch {
    let message = (error as? Failure)?.message ?? error.localizedDescription
    let error: Any = message.hasPrefix("PERMISSION_REQUIRED:") ?
        ["code": "PERMISSION_REQUIRED", "permissionId": String(message.dropFirst("PERMISSION_REQUIRED:".count)),
         "message": "Open ARC Settings → Permissions & readiness to grant access. / 打开 ARC 设置 → 权限与就绪完成授权。"] : message
    let response = try! JSONSerialization.data(withJSONObject: ["ok": false, "error": error], options: [.sortedKeys])
    FileHandle.standardOutput.write(response)
}
FileHandle.standardOutput.write(Data([10]))
