import Foundation
import MetricKit
import os
#if os(macOS)
import AppKit
#endif

/// Finds out what the app was doing when it stops responding (drikin 2026-10-20: the Mac
/// app froze while browsing the timeline and had to be force-quit). The app is sandboxed,
/// so it cannot run `sample` on itself; instead a watcher thread pings the main thread
/// every half second, and when the main thread has not answered for 3 s it writes down:
/// - what the main thread is doing: busy (a layout loop, CPU ≈ 100 %) or waiting (a lock),
///   and its call stack (the thread is paused for a moment and its frames are read);
/// - the last things the app did (tab, thread, refresh, window size …).
/// Then again at 8 s and 20 s, and a line when it recovers. The log survives a force quit:
/// ~/Library/Containers/fm.backspace.bguru.chat/Data/Library/Application Support/Diagnostics/hangs.log
/// (⋯ menu → 「フリーズの記録を Finder で表示」). MetricKit's own hang reports (with
/// symbolicated stacks) are saved next to it when the system delivers them.
final class HangWatch: NSObject, @unchecked Sendable {
    static let shared = HangWatch()

    /// Leave a breadcrumb (cheap; any thread). Kept: the last 80.
    static func note(_ s: @autoclosure () -> String) { shared.add(s()) }

    static var directory: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("Diagnostics", isDirectory: true)
    }
    static var logURL: URL { directory.appendingPathComponent("hangs.log") }

    private let lock = NSLock()
    private var crumbs: [String] = []
    private var crumbIndex = 0
    private let queue = DispatchQueue(label: "fm.backspace.bguru.hangwatch", qos: .utility)
    private var timer: DispatchSourceTimer?
    private let logger = Logger(subsystem: "fm.backspace.bguru.chat", category: "hang")
    private let clock: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
        return f
    }()

    // The main thread (set in start(), on it).
    private var mainPort: thread_act_t = 0
    private var stackLow: UInt = 0
    private var stackHigh: UInt = 0
    /// Frames are collected here while the main thread is paused: nothing may allocate
    /// then (the main thread could be holding the allocator's lock).
    private let frames = UnsafeMutablePointer<UInt>.allocate(capacity: 128)

    // Watcher state (only touched on `queue`).
    private var pingSentAt: UInt64?
    private var reportedStage = 0

    /// Start watching. Call once, on the main thread, early at launch.
    @MainActor func start() {
        guard timer == nil else { return }
        let me = pthread_self()
        mainPort = pthread_mach_thread_np(me)
        stackHigh = UInt(bitPattern: pthread_get_stackaddr_np(me))
        stackLow = stackHigh - UInt(pthread_get_stacksize_np(me))
        MXMetricManager.shared.add(self)
        let info = Bundle.main.infoDictionary
        add("launch \(info?["CFBundleShortVersionString"] ?? "?") (\(info?["CFBundleVersion"] ?? "?")) "
            + ProcessInfo.processInfo.operatingSystemVersionString)
        let t = DispatchSource.makeTimerSource(queue: queue)
        t.schedule(deadline: .now() + 1, repeating: .milliseconds(500), leeway: .milliseconds(100))
        t.setEventHandler { [weak self] in self?.tick() }
        t.resume()
        timer = t
    }

    private func add(_ s: String) {
        let line = "\(clock.string(from: Date())) \(s)"
        lock.lock()
        if crumbs.count < 80 { crumbs.append(line) } else { crumbs[crumbIndex] = line; crumbIndex = (crumbIndex + 1) % 80 }
        lock.unlock()
    }

    private func recentCrumbs() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return Array(crumbs[crumbIndex...] + crumbs[..<crumbIndex])
    }

    // MARK: watcher (on `queue`)

    private func tick() {
        let now = DispatchTime.now().uptimeNanoseconds // stops while the Mac sleeps
        guard let sent = pingSentAt else {
            pingSentAt = now
            DispatchQueue.main.async { [weak self] in self?.pong() }
            return
        }
        let stalled = Double(now - sent) / 1e9
        let stages: [Double] = [3, 8, 20]
        guard reportedStage < stages.count, stalled >= stages[reportedStage] else { return }
        reportedStage += 1
        report(stalled: stalled, first: reportedStage == 1)
    }

    private func pong() {
        queue.async { [weak self] in
            guard let self, let sent = self.pingSentAt else { return }
            if self.reportedStage > 0 {
                let s = Double(DispatchTime.now().uptimeNanoseconds - sent) / 1e9
                self.write("RECOVERED after \(String(format: "%.1f", s)) s\n\n")
                self.logger.error("main thread recovered after \(s, format: .fixed(precision: 1)) s")
            }
            self.pingSentAt = nil
            self.reportedStage = 0
        }
    }

    private func report(stalled: Double, first: Bool) {
        let (cpu, state) = mainThreadUsage()
        let n = sampleMainStack()
        var out = "=== main thread not responding for \(String(format: "%.1f", stalled)) s "
            + "(\(clock.string(from: Date())), main CPU \(cpu) %, \(state)) ===\n"
        out += "stack:\n" + symbolicate(n).joined(separator: "\n") + "\n"
        if first { out += "recent:\n" + recentCrumbs().map { "  " + $0 }.joined(separator: "\n") + "\n" }
        write(out)
        logger.error("main thread not responding for \(stalled, format: .fixed(precision: 1)) s, CPU \(cpu) %, \(state, privacy: .public)")
    }

    // MARK: the main thread, seen from here

    private func mainThreadUsage() -> (Int, String) {
        var info = thread_basic_info()
        var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
        let kr = withUnsafeMutablePointer(to: &info) {
            $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
                thread_info(mainPort, thread_flavor_t(THREAD_BASIC_INFO), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return (-1, "unknown") }
        let state: String
        switch info.run_state {
        case TH_STATE_RUNNING: state = "running (busy)"
        case TH_STATE_WAITING: state = "waiting (blocked)"
        case TH_STATE_UNINTERRUPTIBLE: state = "uninterruptible"
        case TH_STATE_STOPPED: state = "stopped"
        default: state = "state \(info.run_state)"
        }
        return (Int(info.cpu_usage) * 100 / Int(TH_USAGE_SCALE), state)
    }

    /// Pauses the main thread, walks its frame pointers (only inside its own stack, so
    /// every read is safe) and lets it go. Returns how many frames are in `frames`.
    private func sampleMainStack() -> Int {
        guard mainPort != 0, thread_suspend(mainPort) == KERN_SUCCESS else { return 0 }
        defer { thread_resume(mainPort) }
        // Return addresses of system code carry a pointer signature in the top bits.
        let mask: UInt = 0x0000_7FFF_FFFF_FFFF
        var pc: UInt = 0, fp: UInt = 0, lr: UInt = 0
        #if arch(arm64)
        var st = arm_thread_state64_t()
        var count = mach_msg_type_number_t(MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &st) {
            $0.withMemoryRebound(to: natural_t.self, capacity: Int(count)) {
                thread_get_state(mainPort, thread_state_flavor_t(ARM_THREAD_STATE64), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return 0 }
        pc = UInt(st.__pc); fp = UInt(st.__fp); lr = UInt(st.__lr)
        #elseif arch(x86_64)
        var st = x86_thread_state64_t()
        var count = mach_msg_type_number_t(MemoryLayout<x86_thread_state64_t>.size / MemoryLayout<natural_t>.size)
        let kr = withUnsafeMutablePointer(to: &st) {
            $0.withMemoryRebound(to: natural_t.self, capacity: Int(count)) {
                thread_get_state(mainPort, thread_state_flavor_t(x86_THREAD_STATE64), $0, &count)
            }
        }
        guard kr == KERN_SUCCESS else { return 0 }
        pc = UInt(st.__rip); fp = UInt(st.__rbp)
        #else
        return 0
        #endif
        var n = 0
        frames[n] = pc & mask; n += 1
        if lr != 0 { frames[n] = lr & mask; n += 1 }
        var cur = fp
        while n < 128, cur >= stackLow, cur + 16 <= stackHigh, cur & 0x7 == 0,
              let p = UnsafePointer<UInt>(bitPattern: cur) {
            let next = p[0], ret = p[1] & mask
            guard ret != 0 else { break }
            frames[n] = ret; n += 1
            guard next > cur else { break }
            cur = next
        }
        return n
    }

    /// "image +offset symbol" per frame (the offset works with the dSYM and atos).
    private func symbolicate(_ n: Int) -> [String] {
        (0..<n).map { i in
            let a = frames[i]
            var info = Dl_info()
            guard dladdr(UnsafeRawPointer(bitPattern: a), &info) != 0 else { return String(format: "  %2d ? 0x%lx", i, a) }
            let image = info.dli_fname.map { (String(cString: $0) as NSString).lastPathComponent } ?? "?"
            let offset = a &- UInt(bitPattern: info.dli_fbase)
            let sym = info.dli_sname.map { String(cString: $0) } ?? "?"
            let symOffset = a &- UInt(bitPattern: info.dli_saddr)
            return String(format: "  %2d %@ +0x%lx %@ + %lu", i, image, offset, sym, symOffset)
        }
    }

    // MARK: the log file

    private func write(_ text: String) {
        let dir = Self.directory, url = Self.logURL
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        // Keep it small: start over past 1 MB (the previous one is kept as hangs.old.log).
        if let size = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? Int, size > 1_000_000 {
            let old = dir.appendingPathComponent("hangs.old.log")
            try? FileManager.default.removeItem(at: old)
            try? FileManager.default.moveItem(at: url, to: old)
        }
        guard let data = text.data(using: .utf8) else { return }
        if let h = try? FileHandle(forWritingTo: url) {
            defer { try? h.close() }
            _ = try? h.seekToEnd()
            try? h.write(contentsOf: data)
        } else {
            try? data.write(to: url)
        }
    }
}

// MARK: MetricKit (the system's own hang / crash reports, delivered later)

extension HangWatch: MXMetricManagerSubscriber {
    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        let dir = Self.directory
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        for p in payloads {
            let name = "metrickit-\(Int(p.timeStampEnd.timeIntervalSince1970)).json"
            try? p.jsonRepresentation().write(to: dir.appendingPathComponent(name))
            write("MetricKit: report saved as \(name)\n\n")
        }
    }
}
