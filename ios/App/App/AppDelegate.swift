import UIKit
import Capacitor
import AVFoundation
import MediaPlayer

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        // Keep screen awake while synthesizer app is active
        UIApplication.shared.isIdleTimerDisabled = true

        // Configure audio session for low-latency playback even if device is silenced
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .default, options: [.mixWithOthers])
            try session.setActive(true)
        } catch {
            print("[AppDelegate] Failed to set AVAudioSession category: \(error)")
        }

        // Initialize Now Playing info with "PM-8" branding (Option 2: Native iOS APIs)
        setupNowPlayingInfo()

        return true
    }

    private func setupNowPlayingInfo() {
        var info = [String: Any]()
        info[MPMediaItemPropertyTitle] = "PM-8"
        info[MPMediaItemPropertyArtist] = "Polyphonic MPE Synthesizer"
        info[MPMediaItemPropertyAlbumTitle] = "PM-8"
        info[MPNowPlayingInfoPropertyIsLiveStream] = true

        if let iconPath = Bundle.main.path(forResource: "public/assets/icon-pm8", ofType: "png"),
           let image = UIImage(contentsOfFile: iconPath) {
            let artwork = MPMediaItemArtwork(boundsSize: image.size) { _ in image }
            info[MPMediaItemPropertyArtwork] = artwork
        } else if let icon = UIImage(named: "AppIcon") {
            let artwork = MPMediaItemArtwork(boundsSize: icon.size) { _ in icon }
            info[MPMediaItemPropertyArtwork] = artwork
        }

        MPNowPlayingInfoCenter.default().nowPlayingInfo = info

        // Enable remote control events so iOS recognizes this app as an active media provider
        UIApplication.shared.beginReceivingRemoteControlEvents()
        let commandCenter = MPRemoteCommandCenter.shared()
        commandCenter.playCommand.isEnabled = true
        commandCenter.pauseCommand.isEnabled = true
        commandCenter.stopCommand.isEnabled = true
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
        // Use this method to pause ongoing tasks, disable timers, and invalidate graphics rendering callbacks. Games should use this method to pause the game.
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        // Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
        // If your application supports background execution, this method is called instead of applicationWillTerminate: when the user quits.
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        // Called as part of the transition from the background to the active state; here you can undo many of the changes made on entering the background.
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        // Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
    }

    func applicationWillTerminate(_ application: UIApplication) {
        // Called when the application is about to terminate. Save data if appropriate. See also applicationDidEnterBackground:.
    }

    func application(_ application: UIApplication,
                     configurationForConnecting connectingSceneSession: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        let config = UISceneConfiguration(name: "Default Configuration",
                                          sessionRole: connectingSceneSession.role)
        config.delegateClass = SceneDelegate.self
        return config
    }
}
