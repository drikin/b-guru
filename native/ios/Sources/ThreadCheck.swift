#if DEBUG
import UIKit

/// Dev only, the simulator's long-thread check (native/ios/scripts/thread-check.sh):
/// BGURU_DEMO=1 BGURU_DEMO_TAB=timeline BGURU_DEMO_THREAD_CHECK=1 [BGURU_DEMO_REPLIES=N]
/// opens the demo thread with many replies, scrolls it while it opens, to the top and back,
/// goes back and opens it again — and checks that the main thread keeps answering (the Mac
/// froze opening a thread with many replies, 2026-10-21; the screen is the same shared code).
/// Prints "[thread-check] ok …" and exits 0, or "[thread-check] FAIL …" and exits 1 when the
/// main thread does not answer for 5 s (BGURU_THREAD_LIMIT=S).
@MainActor
enum ThreadCheck {
    static func runIfAsked(timeline: TimelineStore) {
        let env = ProcessInfo.processInfo.environment
        guard env["BGURU_DEMO_THREAD_CHECK"] == "1" else { return }
        let limit = env["BGURU_THREAD_LIMIT"].flatMap(Double.init) ?? 5
        let watch = MainThreadWatch(limit: limit) { stalled, step in
            print("[thread-check] FAIL main thread did not respond for \(String(format: "%.1f", stalled)) s (during: \(step))")
            fflush(stdout)
            exit(1)
        }
        Task { @MainActor in
            timeline.debugFill(to: 30) // a full first page, as the server sends
            try? await Task.sleep(for: .seconds(2)) // the app and the timeline page are up
            watch.start()
            // 1) The minute's refresh while a thread is open (the Mac spun at 99 % for good, 0.3.44).
            var rounds = 0
            for thread in [3, TimelineStore.demoLongThreadId] {
                watch.step = "open thread \(thread)"
                timeline.openThread = thread
                try? await Task.sleep(for: .milliseconds(1500))
                for r in 0..<10 {
                    watch.step = "refresh \(r) with thread \(thread) open"
                    timeline.debugRefresh(round: rounds)
                    rounds += 1
                    try? await Task.sleep(for: .milliseconds(600))
                }
                watch.step = "back from thread \(thread)"
                popThread()
                try? await Task.sleep(for: .milliseconds(1000))
            }
            // 2) A long thread: open, scroll, back, open again.
            let before = Set(scrolls().map(ObjectIdentifier.init)) // the timeline's list (not the one to scroll)
            let t0 = Date()
            watch.step = "open thread"
            timeline.openThread = TimelineStore.demoLongThreadId
            var found: UIScrollView?
            while Date().timeIntervalSince(t0) < 10 {
                try? await Task.sleep(for: .milliseconds(50))
                if let s = scrolls().filter({ !before.contains(ObjectIdentifier($0)) }).max(by: { $0.contentSize.height < $1.contentSize.height }),
                   s.contentSize.height > 3000 { found = s; break }
            }
            let openMs = Int(Date().timeIntervalSince(t0) * 1000)
            guard let scroll = found else {
                print("[thread-check] FAIL the thread did not open")
                fflush(stdout)
                exit(1)
            }
            func set(_ y: CGFloat) {
                let maxY = max(-scroll.adjustedContentInset.top, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
                scroll.setContentOffset(CGPoint(x: 0, y: min(max(-scroll.adjustedContentInset.top, y), maxY)), animated: false)
            }
            // A finger on the list at once, while it may still be moving to the newest reply.
            watch.step = "scroll while opening"
            for _ in 0..<40 {
                set(scroll.contentOffset.y - 120)
                try? await Task.sleep(for: .milliseconds(16))
            }
            watch.step = "settle"
            try? await Task.sleep(for: .milliseconds(1200))
            let s0 = Date()
            var steps = 0
            watch.step = "scroll up"
            while scroll.contentOffset.y > -scroll.adjustedContentInset.top + 1 {
                set(scroll.contentOffset.y - scroll.bounds.height * 0.8)
                steps += 1
                try? await Task.sleep(for: .milliseconds(40))
                if steps > 2000 { break }
            }
            watch.step = "jump to bottom"
            set(.greatestFiniteMagnitude)
            try? await Task.sleep(for: .milliseconds(300))
            watch.step = "jump to middle"
            set(scroll.contentSize.height / 2)
            try? await Task.sleep(for: .milliseconds(300))
            watch.step = "scroll down"
            var last = -1.0
            while scroll.contentOffset.y > last + 1 {
                last = scroll.contentOffset.y
                set(scroll.contentOffset.y + scroll.bounds.height * 0.8)
                steps += 1
                try? await Task.sleep(for: .milliseconds(40))
                if steps > 4000 { break }
            }
            let scrollMs = Int(Date().timeIntervalSince(s0) * 1000)
            watch.step = "back"
            popThread()
            try? await Task.sleep(for: .milliseconds(1000))
            watch.step = "open thread again"
            timeline.openThread = TimelineStore.demoLongThreadId
            try? await Task.sleep(for: .milliseconds(2000))
            watch.step = "back again"
            popThread()
            try? await Task.sleep(for: .milliseconds(1000))
            watch.stop()
            print("[thread-check] ok   \(rounds) refreshes with a thread open; \(TimelineStore.demoLongThreadReplies) replies: opened in \(openMs) ms, \(steps) scroll steps in \(scrollMs) ms, longest main-thread stall \(Int(watch.longest * 1000)) ms")
            fflush(stdout)
            exit(0)
        }
    }

    private static var windows: [UIWindow] {
        UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }.flatMap(\.windows)
    }

    /// The scroll views on screen.
    private static func scrolls() -> [UIScrollView] {
        var all: [UIScrollView] = []
        func walk(_ v: UIView) {
            if let s = v as? UIScrollView, s.window != nil, !s.isHidden { all.append(s) }
            v.subviews.forEach(walk)
        }
        windows.forEach(walk)
        return all
    }

    /// Back from the thread, as the ‹ button does.
    private static func popThread() {
        func find(_ vc: UIViewController?) -> UINavigationController? {
            guard let vc else { return nil }
            if let nav = vc as? UINavigationController, nav.viewControllers.count > 1 { return nav }
            for c in vc.children { if let n = find(c) { return n } }
            return find(vc.presentedViewController)
        }
        for w in windows { if let nav = find(w.rootViewController) { nav.popViewController(animated: true); return } }
    }
}
#endif
