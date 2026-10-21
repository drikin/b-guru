// Captures the largest on-screen window of a process (what WindowServer composites — an
// upside-down frame shows here, not in an in-process render).
//   swiftc -O native/mac/scripts/window-shot.swift -o /tmp/window-shot && /tmp/window-shot PID OUT.png
// Needs Screen Recording permission for the terminal that runs it.
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let out = CommandLine.arguments[2]
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
var best: (id: Int, area: Double)?
for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
    guard let b = w[kCGWindowBounds as String] as? [String: Double], let id = w[kCGWindowNumber as String] as? Int else { continue }
    let area = (b["Width"] ?? 0) * (b["Height"] ?? 0)
    if best == nil || area > best!.area { best = (id, area) }
}
guard let id = best?.id else { print("no window"); exit(1) }
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
p.arguments = ["-x", "-o", "-l", String(id), out]
try p.run()
p.waitUntilExit()
exit(p.terminationStatus)
