import UIKit
import Capacitor
import AVFoundation

class SynthBridgeViewController: CAPBridgeViewController {
    private static let orientationPrefsKey = "synth_last_orientation_mask"
    private static let wakeSettleDelay: TimeInterval = 0.8
    private static let rotationDebounceDelay: TimeInterval = 0.25

    static var lockedOrientationMask: UIInterfaceOrientationMask = {
        let saved = UserDefaults.standard.integer(forKey: orientationPrefsKey)
        let validMasks: [UIInterfaceOrientationMask] = [
            .portrait,
            .landscapeLeft,
            .landscapeRight,
            .portraitUpsideDown
        ]
        let candidate = UIInterfaceOrientationMask(rawValue: UInt(saved))
        if saved != 0 && validMasks.contains(candidate) {
            return candidate
        }
        return .portrait
    }()

    private var isAppActive: Bool = true
    private var lastWakeTime: Date = .distantPast
    private var wakeSuppressedMask: UIInterfaceOrientationMask?
    private var orientationDebounceWorkItem: DispatchWorkItem?

    override open var supportedInterfaceOrientations: UIInterfaceOrientationMask {
        return Self.lockedOrientationMask
    }

    override open var shouldAutorotate: Bool {
        return true
    }

    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        if bridge?.plugin(withName: "CoreMidiPlugin") == nil {
            bridge?.registerPluginInstance(CoreMidiPlugin())
            print("[SynthBridgeViewController] Registered CoreMidiPlugin instance in capacitorDidLoad")
        }
    }

    override open func viewDidLoad() {
        super.viewDidLoad()

        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            print("[SynthBridgeViewController] Failed to configure AVAudioSession: \(error)")
        }

        if bridge?.plugin(withName: "CoreMidiPlugin") == nil {
            bridge?.registerPluginInstance(CoreMidiPlugin())
            print("[SynthBridgeViewController] Registered CoreMidiPlugin instance in viewDidLoad")
        }

        setupOrientationPreservation()
    }

    override open func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        enforceLockedOrientation()
    }

    deinit {
        orientationDebounceWorkItem?.cancel()
        NotificationCenter.default.removeObserver(self)
    }

    private func setupOrientationPreservation() {
        UIDevice.current.beginGeneratingDeviceOrientationNotifications()

        // If no orientation was persisted yet, initialize from current physical or interface orientation
        if UserDefaults.standard.integer(forKey: Self.orientationPrefsKey) == 0 {
            if let physicalMask = mapDeviceOrientationToMask(UIDevice.current.orientation) {
                Self.lockedOrientationMask = physicalMask
            } else if let sceneOrientation = view.window?.windowScene?.interfaceOrientation,
                      let sceneMask = mapInterfaceOrientationToMask(sceneOrientation) {
                Self.lockedOrientationMask = sceneMask
            }
            persistLockedOrientation()
        }

        let nc = NotificationCenter.default
        nc.addObserver(
            self,
            selector: #selector(handleDeviceOrientationDidChange),
            name: UIDevice.orientationDidChangeNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(handleAppWillSleep),
            name: UIApplication.willResignActiveNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(handleAppWillSleep),
            name: UIApplication.didEnterBackgroundNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(handleAppDidWake),
            name: UIApplication.willEnterForegroundNotification,
            object: nil
        )
        nc.addObserver(
            self,
            selector: #selector(handleAppDidWake),
            name: UIApplication.didBecomeActiveNotification,
            object: nil
        )
    }

    @objc func handleAppWillSleep() {
        orientationDebounceWorkItem?.cancel()
        orientationDebounceWorkItem = nil
        isAppActive = false
        persistLockedOrientation()
        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
        }
    }

    @objc func handleAppDidWake() {
        orientationDebounceWorkItem?.cancel()
        orientationDebounceWorkItem = nil
        isAppActive = true
        lastWakeTime = Date()

        // If the device was held in a different orientation (e.g. portrait) while unlocking the lock screen,
        // suppress switching until the device moves out of that unlock posture
        if let currentPhysical = mapDeviceOrientationToMask(UIDevice.current.orientation),
           currentPhysical != Self.lockedOrientationMask {
            wakeSuppressedMask = currentPhysical
        } else {
            wakeSuppressedMask = nil
        }

        enforceLockedOrientation()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            self?.enforceLockedOrientation()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            self?.enforceLockedOrientation()
        }
    }

    @objc private func handleDeviceOrientationDidChange() {
        orientationDebounceWorkItem?.cancel()
        orientationDebounceWorkItem = nil

        guard isAppActive, UIApplication.shared.applicationState == .active else {
            return
        }

        guard Date().timeIntervalSince(lastWakeTime) >= Self.wakeSettleDelay else {
            return
        }

        let candidateMask = mapDeviceOrientationToMask(UIDevice.current.orientation)

        if let suppressed = wakeSuppressedMask {
            if candidateMask == suppressed {
                return
            } else {
                wakeSuppressedMask = nil
            }
        }

        guard let targetMask = candidateMask, targetMask != Self.lockedOrientationMask else {
            return
        }

        let workItem = DispatchWorkItem { [weak self] in
            guard let self = self,
                  self.isAppActive,
                  UIApplication.shared.applicationState == .active else {
                return
            }
            guard self.mapDeviceOrientationToMask(UIDevice.current.orientation) == targetMask else {
                return
            }
            Self.lockedOrientationMask = targetMask
            self.persistLockedOrientation()
            self.enforceLockedOrientation()
        }
        orientationDebounceWorkItem = workItem
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.rotationDebounceDelay, execute: workItem)
    }

    private func mapDeviceOrientationToMask(_ orientation: UIDeviceOrientation) -> UIInterfaceOrientationMask? {
        switch orientation {
        case .portrait:
            return .portrait
        case .landscapeLeft:
            // UIDeviceOrientation.landscapeLeft (device top to left) corresponds to UIInterfaceOrientation.landscapeRight
            return .landscapeRight
        case .landscapeRight:
            // UIDeviceOrientation.landscapeRight (device top to right) corresponds to UIInterfaceOrientation.landscapeLeft
            return .landscapeLeft
        case .portraitUpsideDown:
            return UIDevice.current.userInterfaceIdiom == .pad ? .portraitUpsideDown : nil
        default:
            // .faceUp, .faceDown, .unknown -> keep current locked orientation
            return nil
        }
    }

    private func mapInterfaceOrientationToMask(_ orientation: UIInterfaceOrientation) -> UIInterfaceOrientationMask? {
        switch orientation {
        case .portrait:
            return .portrait
        case .landscapeLeft:
            return .landscapeLeft
        case .landscapeRight:
            return .landscapeRight
        case .portraitUpsideDown:
            return UIDevice.current.userInterfaceIdiom == .pad ? .portraitUpsideDown : .portrait
        default:
            return nil
        }
    }

    private func persistLockedOrientation() {
        UserDefaults.standard.set(Int(Self.lockedOrientationMask.rawValue), forKey: Self.orientationPrefsKey)
    }

    func enforceLockedOrientation() {
        guard Thread.isMainThread else {
            DispatchQueue.main.async { [weak self] in
                self?.enforceLockedOrientation()
            }
            return
        }

        let mask = Self.lockedOrientationMask
        if #available(iOS 16.0, *) {
            setNeedsUpdateOfSupportedInterfaceOrientations()
            if let windowScene = view.window?.windowScene
                ?? (UIApplication.shared.connectedScenes.first as? UIWindowScene) {
                windowScene.requestGeometryUpdate(.iOS(interfaceOrientations: mask)) { error in
                    print("[SynthBridgeViewController] Geometry update warning: \(error.localizedDescription)")
                }
            }
        } else {
            let targetOrientation: UIInterfaceOrientation
            switch mask {
            case .landscapeLeft:
                targetOrientation = .landscapeLeft
            case .landscapeRight:
                targetOrientation = .landscapeRight
            case .portraitUpsideDown:
                targetOrientation = .portraitUpsideDown
            default:
                targetOrientation = .portrait
            }
            UIDevice.current.setValue(targetOrientation.rawValue, forKey: "orientation")
            UIViewController.attemptRotationToDeviceOrientation()
        }
    }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }

        window = UIWindow(windowScene: windowScene)
        window?.rootViewController = SynthBridgeViewController()
        window?.makeKeyAndVisible()

        SceneDelegateProxy.shared.scene(scene, willConnectTo: session, options: connectionOptions)
    }

    func sceneWillResignActive(_ scene: UIScene) {
        (window?.rootViewController as? SynthBridgeViewController)?.handleAppWillSleep()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        (window?.rootViewController as? SynthBridgeViewController)?.handleAppWillSleep()
    }

    func sceneWillEnterForeground(_ scene: UIScene) {
        (window?.rootViewController as? SynthBridgeViewController)?.handleAppDidWake()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        (window?.rootViewController as? SynthBridgeViewController)?.handleAppDidWake()
    }

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
