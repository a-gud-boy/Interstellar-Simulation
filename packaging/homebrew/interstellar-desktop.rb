cask "interstellar-desktop" do
  version "0.1.4-beta.3"
  sha256 :no_check # Update to release DMG sha256 on tagged publication

  url "https://github.com/a-gud-boy/Interstellar-Simulation/releases/download/v0.1.4.3-beta/Interstellar-macos-universal.dmg"
  name "Interstellar Observatory"
  desc "Nine real-time relativistic GPU ray-tracing simulators in native Rust and Metal"
  homepage "https://github.com/a-gud-boy/Interstellar-Simulation"

  livecheck do
    url :url
    strategy :github_latest
  end

  app "Interstellar.app"
  binary "#{appdir}/Interstellar.app/Contents/MacOS/interstellar-desktop"

  zap trash: [
    "~/Library/Application Support/interstellar-desktop",
    "~/Library/Preferences/io.github.a-gud-boy.Interstellar.plist",
    "~/Pictures/Interstellar",
  ]
end
