import UIKit
import Capacitor

class SynthBridgeViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        super.capacitorDidLoad()
        if bridge?.plugin(withName: "CoreMidiPlugin") == nil {
            bridge?.registerPluginInstance(CoreMidiPlugin())
            print("[SynthBridgeViewController] Registered CoreMidiPlugin instance in capacitorDidLoad")
        }
    }

    override open func viewDidLoad() {
        super.viewDidLoad()
        if bridge?.plugin(withName: "CoreMidiPlugin") == nil {
            bridge?.registerPluginInstance(CoreMidiPlugin())
            print("[SynthBridgeViewController] Registered CoreMidiPlugin instance in viewDidLoad")
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

    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        SceneDelegateProxy.shared.scene(scene, openURLContexts: URLContexts)
    }

    func scene(_ scene: UIScene, continue userActivity: NSUserActivity) {
        SceneDelegateProxy.shared.scene(scene, continue: userActivity)
    }
}
