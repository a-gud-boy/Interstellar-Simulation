use std::fs;
use std::path::PathBuf;

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum QualityProfile {
    Eco,
    Balanced,
    Ultra,
    Custom,
}

impl QualityProfile {
    pub fn as_str(self) -> &'static str {
        match self {
            QualityProfile::Eco => "eco",
            QualityProfile::Balanced => "balanced",
            QualityProfile::Ultra => "ultra",
            QualityProfile::Custom => "custom",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "eco" => Some(QualityProfile::Eco),
            "balanced" => Some(QualityProfile::Balanced),
            "ultra" => Some(QualityProfile::Ultra),
            "custom" => Some(QualityProfile::Custom),
            _ => None,
        }
    }

    pub fn as_i32(self) -> i32 {
        match self {
            QualityProfile::Eco => 0,
            QualityProfile::Balanced => 1,
            QualityProfile::Ultra => 2,
            QualityProfile::Custom => 3,
        }
    }

    pub fn from_i32(v: i32) -> Option<Self> {
        match v {
            0 => Some(QualityProfile::Eco),
            1 => Some(QualityProfile::Balanced),
            2 => Some(QualityProfile::Ultra),
            3 => Some(QualityProfile::Custom),
            _ => None,
        }
    }

    pub fn preset_values(self) -> Option<(i32, i32, f32, bool)> {
        match self {
            QualityProfile::Eco => Some((0, 75, 1.0, true)),
            QualityProfile::Balanced => Some((1, 100, 1.5, true)),
            QualityProfile::Ultra => Some((2, 100, 2.0, false)),
            QualityProfile::Custom => None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct DesktopSettings {
    pub has_saved: bool,
    pub quality_profile: QualityProfile,
    pub dpr_cap: f32,
    pub resolution_scale: i32,
    pub quality_tier: i32,
    pub vsync: bool,
    pub interactive_drag_scale: bool,
}

impl Default for DesktopSettings {
    fn default() -> Self {
        Self {
            has_saved: false,
            quality_profile: QualityProfile::Balanced,
            dpr_cap: 1.5,
            resolution_scale: 100,
            quality_tier: 1,
            vsync: true,
            interactive_drag_scale: true,
        }
    }
}

impl DesktopSettings {
    pub fn apply_profile(&mut self, profile: QualityProfile) {
        if let Some((quality_tier, resolution_scale, dpr_cap, drag_scale)) = profile.preset_values()
        {
            self.quality_profile = profile;
            self.quality_tier = quality_tier;
            self.resolution_scale = resolution_scale;
            self.dpr_cap = dpr_cap;
            self.interactive_drag_scale = drag_scale;
        }
    }

    pub fn infer_profile(&self) -> QualityProfile {
        for candidate in [
            QualityProfile::Eco,
            QualityProfile::Balanced,
            QualityProfile::Ultra,
        ] {
            if let Some((q, res, dpr, _)) = candidate.preset_values()
                && self.quality_tier == q
                && self.resolution_scale == res
                && (self.dpr_cap - dpr).abs() < 0.05
            {
                return candidate;
            }
        }
        QualityProfile::Custom
    }

    pub fn parse_str(text: &str) -> Self {
        let mut out = Self {
            has_saved: true,
            ..Self::default()
        };
        let mut parsed_any = false;

        for line in text.lines() {
            let trimmed = line.trim();
            if trimmed.is_empty() || trimmed.starts_with('#') {
                continue;
            }
            let Some((raw_k, raw_v)) = trimmed.split_once('=') else {
                continue;
            };
            let k = raw_k.trim();
            let v = raw_v.trim();
            match k {
                "quality_profile" => {
                    if let Some(p) = QualityProfile::parse(v) {
                        out.quality_profile = p;
                        parsed_any = true;
                    }
                }
                "dpr_cap" => {
                    if let Ok(d) = v.parse::<f32>()
                        && d.is_finite()
                    {
                        out.dpr_cap = d.clamp(1.0, 3.0);
                        parsed_any = true;
                    }
                }
                "resolution_scale" => {
                    if let Ok(r) = v.parse::<i32>() {
                        out.resolution_scale = match r {
                            0..=62 => 50,
                            63..=87 => 75,
                            _ => 100,
                        };
                        parsed_any = true;
                    }
                }
                "quality_tier" => {
                    if let Ok(q) = v.parse::<i32>() {
                        out.quality_tier = q.clamp(0, 2);
                        parsed_any = true;
                    }
                }
                "vsync" => {
                    if let Some(b) = parse_bool(v) {
                        out.vsync = b;
                        parsed_any = true;
                    }
                }
                "interactive_drag_scale" => {
                    if let Some(b) = parse_bool(v) {
                        out.interactive_drag_scale = b;
                        parsed_any = true;
                    }
                }
                _ => {}
            }
        }

        if !parsed_any {
            out.has_saved = false;
        } else if out.quality_profile != QualityProfile::Custom {
            out.quality_profile = out.infer_profile();
        }
        out
    }

    pub fn to_config_string(&self) -> String {
        format!(
            "# Interstellar Desktop Graphics Preferences\n\
             quality_profile={}\n\
             dpr_cap={:.2}\n\
             resolution_scale={}\n\
             quality_tier={}\n\
             vsync={}\n\
             interactive_drag_scale={}\n",
            self.quality_profile.as_str(),
            self.dpr_cap.clamp(1.0, 3.0),
            self.resolution_scale,
            self.quality_tier.clamp(0, 2),
            self.vsync,
            self.interactive_drag_scale,
        )
    }

    pub fn load() -> Self {
        let Some(path) = config_path() else {
            return Self::default();
        };
        match fs::read_to_string(&path) {
            Ok(text) => Self::parse_str(&text),
            Err(_) => Self::default(),
        }
    }

    pub fn save(&self) -> bool {
        let Some(path) = config_path() else {
            return false;
        };
        if let Some(parent) = path.parent()
            && fs::create_dir_all(parent).is_err()
        {
            return false;
        }
        fs::write(path, self.to_config_string()).is_ok()
    }
}

fn parse_bool(s: &str) -> Option<bool> {
    match s.trim().to_ascii_lowercase().as_str() {
        "true" | "1" | "on" | "yes" => Some(true),
        "false" | "0" | "off" | "no" => Some(false),
        _ => None,
    }
}

pub fn config_path() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    if let Ok(appdata) = std::env::var("APPDATA")
        && !appdata.is_empty()
    {
        return Some(
            PathBuf::from(appdata)
                .join("InterstellarObservatory")
                .join("settings.cfg"),
        );
    }

    #[cfg(target_os = "macos")]
    if let Ok(home) = std::env::var("HOME")
        && !home.is_empty()
    {
        return Some(
            PathBuf::from(home)
                .join("Library")
                .join("Application Support")
                .join("InterstellarObservatory")
                .join("settings.cfg"),
        );
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    {
        if let Ok(xdg) = std::env::var("XDG_CONFIG_HOME")
            && !xdg.is_empty()
        {
            return Some(
                PathBuf::from(xdg)
                    .join("interstellar-observatory")
                    .join("settings.cfg"),
            );
        }
        if let Ok(home) = std::env::var("HOME")
            && !home.is_empty()
        {
            return Some(
                PathBuf::from(home)
                    .join(".config")
                    .join("interstellar-observatory")
                    .join("settings.cfg"),
            );
        }
    }

    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_roundtrip_and_clamping() {
        let mut s = DesktopSettings::default();
        s.apply_profile(QualityProfile::Ultra);
        s.vsync = false;
        let encoded = s.to_config_string();
        let parsed = DesktopSettings::parse_str(&encoded);
        assert!(parsed.has_saved);
        assert_eq!(parsed.quality_profile, QualityProfile::Ultra);
        assert!((parsed.dpr_cap - 2.0).abs() < 1e-4);
        assert_eq!(parsed.resolution_scale, 100);
        assert_eq!(parsed.quality_tier, 2);
        assert!(!parsed.vsync);
        assert!(!parsed.interactive_drag_scale);
    }

    #[test]
    fn settings_infer_custom_and_ignore_garbage() {
        let parsed = DesktopSettings::parse_str(
            "# comment\n\
             invalid_line\n\
             dpr_cap=99.0\n\
             quality_tier=1\n\
             resolution_scale=75\n\
             vsync=off\n",
        );
        assert!(parsed.has_saved);
        assert!((parsed.dpr_cap - 3.0).abs() < 1e-4);
        assert_eq!(parsed.resolution_scale, 75);
        assert!(!parsed.vsync);
        assert_eq!(parsed.infer_profile(), QualityProfile::Custom);
    }
}
