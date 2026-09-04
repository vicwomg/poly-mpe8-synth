// ios/App/App/CoreMidiPlugin.swift
import Foundation
import Capacitor
import CoreMIDI

@objc(CoreMidiPlugin)
public class CoreMidiPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "CoreMidiPlugin"
    public let jsName = "CoreMidiPlugin"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "listInputs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "scanInputs", returnType: CAPPluginReturnPromise)
    ]

    public static weak var shared: CoreMidiPlugin?

    private var midiClient = MIDIClientRef()
    private var inputPort = MIDIPortRef()
    private var isMidiSetup = false

    override public func load() {
        super.load()
        CoreMidiPlugin.shared = self
        setupMidi()
    }

    private func setupMidi() {
        guard !isMidiSetup else { return }

        // 1. Create client with notification handler for device plug/unplug
        var status = MIDIClientCreateWithBlock("PolyMpeCoreMidiClient" as CFString, &midiClient) { [weak self] notificationPtr in
            let msgId = notificationPtr.pointee.messageID
            if msgId == .msgObjectAdded || msgId == .msgObjectRemoved {
                DispatchQueue.main.async {
                    self?.connectAllSources()
                    self?.notifyListeners("devicesChanged", data: [
                        "inputs": self?.getInputList() ?? []
                    ])
                }
            }
        }

        guard status == noErr else {
            print("[CoreMidiPlugin] Failed to create MIDIClient: \(status)")
            return
        }

        // 2. Create input port with receive block
        status = MIDIInputPortCreateWithBlock(midiClient, "PolyMpeCoreMidiPort" as CFString, &inputPort) { [weak self] packetListPointer, _ in
            let packetList = packetListPointer.pointee
            var packet = packetList.packet
            for _ in 0..<packetList.numPackets {
                let length = Int(packet.length)
                if length > 0 {
                    var bytes = [UInt8]()
                    withUnsafePointer(to: &packet.data) { dataPtr in
                        dataPtr.withMemoryRebound(to: UInt8.self, capacity: length) { rawBytes in
                            for i in 0..<length {
                                bytes.append(rawBytes[i])
                            }
                        }
                    }
                    if !bytes.isEmpty {
                        DispatchQueue.main.async {
                            self?.notifyMidiBytes(bytes)
                        }
                    }
                }
                packet = MIDIPacketNext(&packet).pointee
            }
        }

        guard status == noErr else {
            print("[CoreMidiPlugin] Failed to create InputPort: \(status)")
            return
        }

        isMidiSetup = true
        connectAllSources()
    }

    private func connectAllSources() {
        let count = MIDIGetNumberOfSources()
        for i in 0..<count {
            let src = MIDIGetSource(i)
            MIDIPortConnectSource(inputPort, src, nil)
        }
    }

    private func getEndpointName(_ endpoint: MIDIEndpointRef) -> String {
        var param: Unmanaged<CFString>?
        let err = MIDIObjectGetStringProperty(endpoint, kMIDIPropertyDisplayName, &param)
        if err == noErr, let name = param?.takeRetainedValue() as String? {
            return name
        }
        var nameParam: Unmanaged<CFString>?
        let err2 = MIDIObjectGetStringProperty(endpoint, kMIDIPropertyName, &nameParam)
        if err2 == noErr, let name2 = nameParam?.takeRetainedValue() as String? {
            return name2
        }
        return "CoreMIDI Device \(endpoint)"
    }

    private func getInputList() -> [[String: Any]] {
        var list = [[String: Any]]()
        let count = MIDIGetNumberOfSources()
        for i in 0..<count {
            let src = MIDIGetSource(i)
            var uniqueID: Int32 = 0
            MIDIObjectGetIntegerProperty(src, kMIDIPropertyUniqueID, &uniqueID)
            list.append([
                "id": "\(uniqueID != 0 ? uniqueID : Int32(i))",
                "name": getEndpointName(src)
            ])
        }
        return list
    }

    public func notifyMidiBytes(_ bytes: [UInt8]) {
        notifyListeners("midiMessage", data: [
            "data": bytes,
            "timestamp": Date().timeIntervalSince1970 * 1000.0
        ])
    }

    @objc func listInputs(_ call: CAPPluginCall) {
        call.resolve(["inputs": getInputList()])
    }

    @objc func scanInputs(_ call: CAPPluginCall) {
        connectAllSources()
        call.resolve(["inputs": getInputList()])
    }
}
