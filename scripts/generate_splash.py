import os
import subprocess

# Single high-resolution splash icon drawable for Android SplashScreen API (Android 12+ & AndroidX compat)
# Android automatically scales @drawable/splash_icon into the 288dp splash icon container across all densities.
# Safe zone is 2/3 of the canvas; 375px inside 864px (~43.4%) keeps the entire logo inside the circular mask.
SPLASH_ICON_FILE = ("android/app/src/main/res/drawable/splash_icon.png", 864, 375)

MASTER_ICON = "assets/icon-pm8.png"


def generate_splashes():
    if not os.path.exists(MASTER_ICON):
        raise FileNotFoundError(f"Master icon not found: {MASTER_ICON}")

    file_path, canvas_size, icon_size = SPLASH_ICON_FILE
    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    cmd = [
        "magick",
        "-size", f"{canvas_size}x{canvas_size}",
        "xc:none",
        "(", MASTER_ICON, "-level", "11.8%,100%", "-resize", f"{icon_size}x{icon_size}", ")",
        "-gravity", "center",
        "-composite",
        file_path,
    ]
    subprocess.run(cmd, check=True)
    print(f"Generated {file_path} ({canvas_size}x{canvas_size}, icon: {icon_size}px)")


if __name__ == "__main__":
    generate_splashes()
