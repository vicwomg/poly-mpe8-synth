import os
import subprocess

SPLASH_FILES = [
    ("android/app/src/main/res/drawable/splash.png", 480, 320),
    ("android/app/src/main/res/drawable-land-mdpi/splash.png", 480, 320),
    ("android/app/src/main/res/drawable-land-hdpi/splash.png", 800, 480),
    ("android/app/src/main/res/drawable-land-xhdpi/splash.png", 1280, 720),
    ("android/app/src/main/res/drawable-land-xxhdpi/splash.png", 1600, 960),
    ("android/app/src/main/res/drawable-land-xxxhdpi/splash.png", 1920, 1280),
    ("android/app/src/main/res/drawable-port-mdpi/splash.png", 320, 480),
    ("android/app/src/main/res/drawable-port-hdpi/splash.png", 480, 800),
    ("android/app/src/main/res/drawable-port-xhdpi/splash.png", 720, 1280),
    ("android/app/src/main/res/drawable-port-xxhdpi/splash.png", 960, 1600),
    ("android/app/src/main/res/drawable-port-xxxhdpi/splash.png", 1280, 1920),
]

# Dedicated splash icon drawables for Android 12+ (API 31+) SplashScreen API
# Canvas is 288dp square (no background icon mode). Safe zone is diameter 192dp (2/3 of canvas).
# Icon size is ~43.4% of canvas so entire chassis & rounded corners comfortably fit inside safe zone.
SPLASH_ICON_FILES = [
    ("android/app/src/main/res/drawable/splash_icon.png", 864, 375),
    ("android/app/src/main/res/drawable-mdpi/splash_icon.png", 288, 125),
    ("android/app/src/main/res/drawable-hdpi/splash_icon.png", 432, 188),
    ("android/app/src/main/res/drawable-xhdpi/splash_icon.png", 576, 250),
    ("android/app/src/main/res/drawable-xxhdpi/splash_icon.png", 864, 375),
    ("android/app/src/main/res/drawable-xxxhdpi/splash_icon.png", 1152, 500),
]

MASTER_ICON = "scratch/icon_pm8_master.png"

def generate_splashes():
    if not os.path.exists(MASTER_ICON):
        raise FileNotFoundError(f"Master icon not found: {MASTER_ICON}")

    # 1. Generate full-screen splash drawables (pure black background)
    for file_path, w, h in SPLASH_FILES:
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        short_dim = min(w, h)
        icon_size = max(80, int(short_dim * 0.32))
        
        cmd = [
            "magick",
            "-size", f"{w}x{h}",
            "xc:#000000",
            "(", MASTER_ICON, "-resize", f"{icon_size}x{icon_size}", ")",
            "-gravity", "center",
            "-composite",
            file_path
        ]
        subprocess.run(cmd, check=True)
        print(f"Generated {file_path} ({w}x{h}, icon: {icon_size}px)")

    # 2. Generate dedicated splash icons for Android 12+ SplashScreen API (transparent background)
    for file_path, canvas_size, icon_size in SPLASH_ICON_FILES:
        os.makedirs(os.path.dirname(file_path), exist_ok=True)
        cmd = [
            "magick",
            "-size", f"{canvas_size}x{canvas_size}",
            "xc:none",
            "(", MASTER_ICON, "-resize", f"{icon_size}x{icon_size}", ")",
            "-gravity", "center",
            "-composite",
            file_path
        ]
        subprocess.run(cmd, check=True)
        print(f"Generated splash icon {file_path} ({canvas_size}x{canvas_size}, icon: {icon_size}px)")

if __name__ == "__main__":
    generate_splashes()
