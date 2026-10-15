import AppKit
import Carbon.HIToolbox

/// System-wide hotkey via Carbon's RegisterEventHotKey — works from any app
/// and needs no Accessibility permission.
@MainActor
final class HotKey {
    private var ref: EventHotKeyRef?
    private var handler: EventHandlerRef?
    private let action: () -> Void
    private static var instances: [UInt32: HotKey] = [:]
    private static var nextId: UInt32 = 1

    init(keyCode: Int, modifiers: NSEvent.ModifierFlags, action: @escaping () -> Void) {
        self.action = action
        let id = HotKey.nextId
        HotKey.nextId += 1
        HotKey.instances[id] = self

        var mods: UInt32 = 0
        if modifiers.contains(.control) { mods |= UInt32(controlKey) }
        if modifiers.contains(.option) { mods |= UInt32(optionKey) }
        if modifiers.contains(.command) { mods |= UInt32(cmdKey) }
        if modifiers.contains(.shift) { mods |= UInt32(shiftKey) }

        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, _ -> OSStatus in
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                              nil, MemoryLayout<EventHotKeyID>.size, nil, &hk)
            let id = hk.id
            DispatchQueue.main.async {
                MainActor.assumeIsolated { HotKey.instances[id]?.action() }
            }
            return noErr
        }, 1, &spec, nil, &handler)

        let hkId = EventHotKeyID(signature: OSType(0x4247_5543 /* BGUC */), id: id)
        RegisterEventHotKey(UInt32(keyCode), mods, hkId, GetApplicationEventTarget(), 0, &ref)
    }
}
