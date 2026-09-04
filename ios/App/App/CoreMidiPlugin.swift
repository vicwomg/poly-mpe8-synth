// ios/App/App/CoreMidiPlugin.swift
import Foundation
import Capacitor
import CoreMIDI

@objc(CoreMidiPlugin)
public class CoreMidiPlugin: CAPPlugin {
    public static weak var shared: CoreMidiPlugin?

    private var midiClient = MIDIClientRef()
    private var inputPort = MIDIPortRef()
    private var isMidiSetup = false
    private var rxPacketCount: Int = 0
    private var lastRxBytesHex: String = "none"
    private var lastError: String?

    override public func load() {
        super.load()
        CoreMidiPlugin.shared = self
        setupMidi()
    }

    private func setupMidi() {
        guard !isMidiSetup else { return }

        // 1. Create client with notification handler for device plug/unplug & state changes
        let statusClient = MIDIClientCreateWithBlock("PolyMpeCoreMidiClient" as CFString, &midiClient) { [weak self] notificationPtr in
            let msgId = notificationPtr.pointee.messageID
            if msgId == .msgObjectAdded || msgId == .msgObjectRemoved || msgId == .msgPropertyChanged {
                DispatchQueue.main.async {
                    self?.connectAllSources()
                    self?.notifyListeners("devicesChanged", data: [
                        "inputs": self?.getInputList() ?? []
                    ])
                }
            }
        }

        guard statusClient == noErr else {
            print("[CoreMidiPlugin] Failed to create MIDIClient: \(statusClient)")
            return
        }

        // 2. Create input port with real-time receive block
        let statusPort = MIDIInputPortCreateWithBlock(midiClient, "PolyMpeCoreMidiPort" as CFString, &inputPort) { [weak self] packetListPointer, _ in
            let numPackets = packetListPointer.pointee.numPackets
            guard numPackets > 0 else { return }

            let offset = MemoryLayout<MIDIPacketList>.offset(of: \.packet) ?? 8
            var packetPtr: UnsafeMutablePointer<MIDIPacket> = UnsafeMutableRawPointer(mutating: packetListPointer)
                .advanced(by: offset)
                .assumingMemoryBound(to: MIDIPacket.self)

            for _ in 0..<numPackets {
                let length = Int(packetPtr.pointee.length)
                if length > 0 {
                    var bytes = [UInt8](repeating: 0, count: length)
                    withUnsafePointer(to: packetPtr.pointee.data) { dataTuplePtr in
                        dataTuplePtr.withMemoryRebound(to: UInt8.self, capacity: length) { rawBytes in
                            for i in 0..<length {
                                bytes[i] = rawBytes[i]
                            }
                        }
                    }
                    if !bytes.isEmpty {
                        DispatchQueue.main.async {
                            self?.notifyMidiBytes(bytes)
                        }
                    }
                }
                packetPtr = MIDIPacketNext(packetPtr)
            }
        }

        guard statusPort == noErr else {
            print("[CoreMidiPlugin] Failed to create InputPort: \(statusPort)")
            return
        }

        isMidiSetup = true
        connectAllSources()
        print("[CoreMidiPlugin] MIDI setup successfully completed.")
    }

    private func connectAllSources() {
        guard isMidiSetup else { return }
        let count = MIDIGetNumberOfSources()
        print("[CoreMidiPlugin] connectAllSources found \(count) source(s)")
        for i in 0..<count {
            let src = MIDIGetSource(i)
            let name = getEndpointName(src)
            print("[CoreMidiPlugin] Connecting source [\(i)]: \(name)")
            let status = MIDIPortConnectSource(inputPort, src, nil)
            if status != noErr {
                print("[CoreMidiPlugin] MIDIPortConnectSource returned error \(status) for source: \(name)")
            }
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
        rxPacketCount += 1
        lastRxBytesHex = bytes.map { String(format: "%02X", $0) }.joined(separator: " ")
        print("[CoreMidiPlugin] RX MIDI [\(rxPacketCount)]: \(lastRxBytesHex)")

        // Slice stream into individual MIDI 1.0 messages
        var index = 0
        while index < bytes.count {
            let status = bytes[index]
            guard status >= 0x80 else {
                index += 1
                continue
            }

            let messageType = status & 0xF0
            var msgLen = 1
            if messageType == 0xC0 || messageType == 0xD0 {
                msgLen = 2
            } else if (messageType >= 0x80 && messageType <= 0xB0) || messageType == 0xE0 {
                msgLen = 3
            } else if status >= 0xF8 {
                msgLen = 1
            } else if status == 0xF0 {
                var end = index + 1
                while end < bytes.count && bytes[end] != 0xF7 {
                    end += 1
                }
                if end < bytes.count && bytes[end] == 0xF7 {
                    end += 1
                }
                msgLen = end - index
            } else {
                if status == 0xF1 || status == 0xF3 { msgLen = 2 }
                else if status == 0xF2 { msgLen = 3 }
                else { msgLen = 1 }
            }

            let endIdx = min(index + msgLen, bytes.count)
            let msgBytes = Array(bytes[index..<endIdx])

            notifyListeners("midiMessage", data: [
                "data": msgBytes,
                "timestamp": Date().timeIntervalSince1970 * 1000.0
            ])

            index = endIdx
        }
    }

    @objc func listInputs(_ call: CAPPluginCall) {
        setupMidi()
        connectAllSources()
        call.resolve(["inputs": getInputList()])
    }

    @objc func scanInputs(_ call: CAPPluginCall) {
        setupMidi()
        connectAllSources()
        call.resolve(["inputs": getInputList()])
    }

    @objc func getDiagnostics(_ call: CAPPluginCall) {
        setupMidi()
        connectAllSources()
        let count = MIDIGetNumberOfSources()
        let sources = getInputList()
        call.resolve([
            "isMidiSetup": isMidiSetup,
            "hasClient": midiClient != 0,
            "hasInputPort": inputPort != 0,
            "sourceCount": count,
            "sources": sources,
            "rxPacketCount": rxPacketCount,
            "lastRxBytes": lastRxBytesHex,
            "lastError": lastError ?? "none"
        ])
    }
}
