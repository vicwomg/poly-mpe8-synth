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
        CAPPluginMethod(name: "scanInputs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listOutputs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sendMidi", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getDiagnostics", returnType: CAPPluginReturnPromise)
    ]

    public static weak var shared: CoreMidiPlugin?

    private var midiClient = MIDIClientRef()
    private var inputPort = MIDIPortRef()
    private var outputPort = MIDIPortRef()
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
            lastError = "Failed to create MIDIClient: \(statusClient)"
            print("[CoreMidiPlugin] \(lastError!)")
            return
        }

        // 2. Create input port with real-time receive block
        let statusPort = MIDIInputPortCreateWithBlock(midiClient, "PolyMpeCoreMidiPort" as CFString, &inputPort) { [weak self] packetListPointer, srcConnRefCon in
            let endpoint = MIDIEndpointRef(Int(bitPattern: srcConnRefCon))
            let sourceName = self?.getEndpointName(endpoint) ?? "CoreMIDI"
            var uniqueID: Int32 = 0
            if endpoint != 0 {
                MIDIObjectGetIntegerProperty(endpoint, kMIDIPropertyUniqueID, &uniqueID)
            }
            let sourceId = "\(uniqueID != 0 ? uniqueID : Int32(endpoint))"

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
                    withUnsafeBytes(of: packetPtr.pointee.data) { rawBuffer in
                        for i in 0..<min(length, rawBuffer.count) {
                            bytes[i] = rawBuffer[i]
                        }
                    }
                    if !bytes.isEmpty {
                        DispatchQueue.main.async {
                            self?.notifyMidiBytes(bytes, sourceId: sourceId, sourceName: sourceName)
                        }
                    }
                }
                packetPtr = MIDIPacketNext(packetPtr)
            }
        }

        guard statusPort == noErr else {
            lastError = "Failed to create InputPort: \(statusPort)"
            print("[CoreMidiPlugin] \(lastError!)")
            return
        }

        // 3. Create output port for sending MIDI / SysEx messages
        let statusOutPort = MIDIOutputPortCreate(midiClient, "PolyMpeCoreMidiOutputPort" as CFString, &outputPort)
        if statusOutPort != noErr {
            print("[CoreMidiPlugin] Warning: Failed to create OutputPort: \(statusOutPort)")
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
            let refCon = UnsafeMutableRawPointer(bitPattern: Int(src))
            let status = MIDIPortConnectSource(inputPort, src, refCon)
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
            let name = getEndpointName(src)
            let isNetwork = name.localizedCaseInsensitiveContains("network session") || name.localizedCaseInsensitiveContains("rtp")
            list.append([
                "id": "\(uniqueID != 0 ? uniqueID : Int32(i))",
                "name": name,
                "isNetwork": isNetwork
            ])
        }
        list.sort { a, b in
            let aNet = a["isNetwork"] as? Bool ?? false
            let bNet = b["isNetwork"] as? Bool ?? false
            if !aNet && bNet { return true }
            if aNet && !bNet { return false }
            return false
        }
        return list
    }

    public func notifyMidiBytes(_ bytes: [UInt8], sourceId: String = "", sourceName: String = "") {
        rxPacketCount += 1
        lastRxBytesHex = bytes.map { String(format: "%02X", $0) }.joined(separator: " ")
        print("[CoreMidiPlugin] RX MIDI [\(rxPacketCount)] from \(sourceName) (\(sourceId)): \(lastRxBytesHex)")

        // 1. Direct WKWebView Event Dispatch (Fastest, zero-serialization, 100% reliable)
        let jsonBytes = "[" + bytes.map { String($0) }.joined(separator: ",") + "]"
        let escapedName = sourceName.replacingOccurrences(of: "'", with: "\\'")
        let js = "window.dispatchEvent(new CustomEvent('coremidimessage', { detail: { data: \(jsonBytes), sourceId: '\(sourceId)', sourceName: '\(escapedName)' } }));"
        self.webView?.evaluateJavaScript(js, completionHandler: nil)

        // 2. Also notify standard Capacitor listeners if any are registered
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
                "sourceId": sourceId,
                "sourceName": sourceName,
                "timestamp": Date().timeIntervalSince1970 * 1000.0
            ])

            index = endIdx
        }
    }

    private func getOutputList() -> [[String: Any]] {
        var list = [[String: Any]]()
        let count = MIDIGetNumberOfDestinations()
        for i in 0..<count {
            let dest = MIDIGetDestination(i)
            var uniqueID: Int32 = 0
            MIDIObjectGetIntegerProperty(dest, kMIDIPropertyUniqueID, &uniqueID)
            let name = getEndpointName(dest)
            let isNetwork = name.localizedCaseInsensitiveContains("network session") || name.localizedCaseInsensitiveContains("rtp")
            list.append([
                "id": "\(uniqueID != 0 ? uniqueID : Int32(i))",
                "name": name,
                "isNetwork": isNetwork
            ])
        }
        return list
    }

    @objc public func listOutputs(_ call: CAPPluginCall) {
        setupMidi()
        call.resolve(["outputs": getOutputList()])
    }

    @objc public func sendMidi(_ call: CAPPluginCall) {
        setupMidi()
        guard let dataArray = call.getArray("data") as? [Int], !dataArray.isEmpty else {
            call.reject("Missing or empty data array")
            return
        }
        guard outputPort != 0 else {
            call.reject("MIDI Output port is not active")
            return
        }

        let bytes = dataArray.map { UInt8($0 & 0xFF) }
        let targetId = call.getString("destinationId")
        let targetName = call.getString("destinationName")?.lowercased()

        let destCount = MIDIGetNumberOfDestinations()
        guard destCount > 0 else {
            call.reject("No MIDI destination endpoints available")
            return
        }

        var destination: MIDIEndpointRef = 0

        for i in 0..<destCount {
            let dest = MIDIGetDestination(i)
            var uid: Int32 = 0
            MIDIObjectGetIntegerProperty(dest, kMIDIPropertyUniqueID, &uid)
            let name = getEndpointName(dest).lowercased()

            if let targetId = targetId, (targetId == "\(uid)" || targetId == "\(dest)") {
                destination = dest
                break
            }
            if let targetName = targetName, name.contains(targetName) {
                destination = dest
                break
            }
            if destination == 0 && (name.contains("midisteel") || name.contains("teensy") || name.contains("lapsteel")) {
                destination = dest
            }
        }

        if destination == 0 {
            for i in 0..<destCount {
                let dest = MIDIGetDestination(i)
                let name = getEndpointName(dest).lowercased()
                if !name.contains("network session") && !name.contains("rtp") {
                    destination = dest
                    break
                }
            }
        }
        if destination == 0 {
            destination = MIDIGetDestination(0)
        }

        let packetListSize = MemoryLayout<MIDIPacketList>.size + bytes.count + 64
        let rawBuffer = UnsafeMutablePointer<UInt8>.allocate(capacity: packetListSize)
        defer { rawBuffer.deallocate() }

        let packetListPtr = rawBuffer.withMemoryRebound(to: MIDIPacketList.self, capacity: 1) { $0 }
        var curPacket = MIDIPacketListInit(packetListPtr)
        curPacket = MIDIPacketListAdd(packetListPtr, packetListSize, curPacket, 0, bytes.count, bytes)

        if curPacket != nil {
            let status = MIDISend(outputPort, destination, packetListPtr)
            if status == noErr {
                call.resolve(["success": true, "bytesSent": bytes.count])
            } else {
                call.reject("MIDISend failed with error \(status)")
            }
        } else {
            call.reject("Failed to format MIDIPacket")
        }
    }

    @objc public func listInputs(_ call: CAPPluginCall) {
        setupMidi()
        connectAllSources()
        call.resolve(["inputs": getInputList()])
    }

    @objc public func scanInputs(_ call: CAPPluginCall) {
        setupMidi()
        connectAllSources()
        call.resolve(["inputs": getInputList()])
    }

    @objc public func getDiagnostics(_ call: CAPPluginCall) {
        setupMidi()
        connectAllSources()
        let count = MIDIGetNumberOfSources()
        let sources = getInputList()
        let listeners = self.getListeners("midiMessage")?.count ?? 0
        call.resolve([
            "isMidiSetup": isMidiSetup,
            "hasClient": midiClient != 0,
            "hasInputPort": inputPort != 0,
            "sourceCount": count,
            "sources": sources,
            "rxPacketCount": rxPacketCount,
            "lastRxBytes": lastRxBytesHex,
            "lastError": lastError ?? "none",
            "listenerCount": listeners,
            "hasWebView": self.webView != nil
        ])
    }
}
