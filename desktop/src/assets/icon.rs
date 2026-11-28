use winit::window::Icon;

pub const LINUX_APP_ID: &str = "io.github.agudboy.interstellar-desktop";
pub const APP_ICON_PNG: &[u8] = include_bytes!("../../../shared/assets/app-icon-256.png");
#[cfg(target_os = "linux")]
pub const APP_ICON_SVG: &[u8] = include_bytes!("../../../shared/assets/app-icon.svg");

/// Decodes the embedded 256x256 RGBA PNG app icon into `(width, height, rgba_bytes)`.
pub fn decode_app_icon_rgba() -> (u32, u32, Vec<u8>) {
    let img = image::load_from_memory_with_format(APP_ICON_PNG, image::ImageFormat::Png)
        .expect("Embedded app-icon-256.png must decode")
        .to_rgba8();
    let (width, height) = img.dimensions();
    (width, height, img.into_raw())
}

/// Builds a `winit::window::Icon` from the embedded canonical app icon.
pub fn load_window_icon() -> Option<Icon> {
    let (width, height, rgba) = decode_app_icon_rgba();
    Icon::from_rgba(rgba, width, height).ok()
}

#[cfg(target_os = "linux")]
fn write_if_changed(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<bool> {
    if let Ok(existing) = std::fs::read(path)
        && existing == bytes
    {
        return Ok(false);
    }
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    std::fs::write(path, bytes)?;
    Ok(true)
}

#[cfg(target_os = "linux")]
fn quote_desktop_exec_arg(arg: &str) -> String {
    let needs_quotes = arg.is_empty()
        || arg.bytes().any(|b| {
            matches!(
                b,
                b' ' | b'\t'
                    | b'\n'
                    | b'"'
                    | b'\''
                    | b'\\'
                    | b'>'
                    | b'<'
                    | b'~'
                    | b'|'
                    | b'&'
                    | b';'
                    | b'$'
                    | b'*'
                    | b'?'
                    | b'#'
                    | b'('
                    | b')'
                    | b'`'
            )
        });
    if !needs_quotes {
        return arg.to_string();
    }
    let mut out = String::with_capacity(arg.len() + 4);
    out.push('"');
    for ch in arg.chars() {
        if matches!(ch, '"' | '`' | '$' | '\\') {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

#[cfg(target_os = "linux")]
fn build_desktop_entry(exec_path: &str) -> String {
    let quoted_exec = quote_desktop_exec_arg(exec_path);
    format!(
        "[Desktop Entry]\n\
         Version=1.0\n\
         Type=Application\n\
         Name=Interstellar Observatory\n\
         GenericName=Relativistic Spacetime Simulator\n\
         Comment=Real-time WebGPU relativistic spacetime GPU simulators\n\
         Exec={quoted_exec}\n\
         Icon={LINUX_APP_ID}\n\
         Terminal=false\n\
         Categories=Science;Astronomy;Physics;\n\
         StartupNotify=true\n\
         StartupWMClass={LINUX_APP_ID}\n"
    )
}

/// Ensures the user's XDG `hicolor` icon theme and `.desktop` entry exist so Wayland
/// compositors (GNOME Shell, KDE Plasma, etc.) display the default app icon via `app_id`.
#[cfg(target_os = "linux")]
pub fn ensure_linux_desktop_integration() {
    let data_home = std::env::var_os("XDG_DATA_HOME")
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .or_else(|| {
            std::env::var_os("HOME")
                .filter(|s| !s.is_empty())
                .map(|h| std::path::PathBuf::from(h).join(".local/share"))
        });
    let Some(data_home) = data_home else {
        return;
    };

    let hicolor_dir = data_home.join("icons/hicolor");
    let svg_path = hicolor_dir.join(format!("scalable/apps/{LINUX_APP_ID}.svg"));
    let png_path = hicolor_dir.join(format!("256x256/apps/{LINUX_APP_ID}.png"));
    let apps_dir = data_home.join("applications");
    let desktop_path = apps_dir.join(format!("{LINUX_APP_ID}.desktop"));

    let exe_str = std::env::current_exe()
        .ok()
        .and_then(|p| p.into_os_string().into_string().ok())
        .unwrap_or_else(|| "interstellar-desktop".to_string());
    let desktop_contents = build_desktop_entry(&exe_str);

    let mut icons_updated = false;
    if let Ok(changed) = write_if_changed(&svg_path, APP_ICON_SVG) {
        icons_updated |= changed;
    }
    if let Ok(changed) = write_if_changed(&png_path, APP_ICON_PNG) {
        icons_updated |= changed;
    }
    let desktop_updated =
        write_if_changed(&desktop_path, desktop_contents.as_bytes()).unwrap_or(false);

    if icons_updated {
        for tool in ["gtk-update-icon-cache", "gtk4-update-icon-cache"] {
            if let Ok(status) = std::process::Command::new(tool)
                .arg("-f")
                .arg("-t")
                .arg(&hicolor_dir)
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                && status.success()
            {
                break;
            }
        }
    }
    if desktop_updated {
        let _ = std::process::Command::new("update-desktop-database")
            .arg(&apps_dir)
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_app_icon_decodes_and_builds_window_icon() {
        let (width, height, rgba) = decode_app_icon_rgba();
        assert_eq!(width, 256);
        assert_eq!(height, 256);
        assert_eq!(rgba.len(), 256 * 256 * 4);
        assert!(load_window_icon().is_some());
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_desktop_entry_quotes_paths_with_spaces() {
        let entry = build_desktop_entry("/media/bruno/Vibe Code/Trial/interstellar-desktop");
        assert!(entry.contains("Exec=\"/media/bruno/Vibe Code/Trial/interstellar-desktop\""));
        assert!(entry.contains(&format!("Icon={LINUX_APP_ID}")));
        assert!(entry.contains(&format!("StartupWMClass={LINUX_APP_ID}")));
        assert!(
            entry
                .lines()
                .all(|line| !line.starts_with(' ') && line != "\\")
        );
    }
}
