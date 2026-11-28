use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=assets/app-icon.ico");

    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        return;
    }

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let ico_path = manifest_dir.join("assets").join("app-icon.ico");
    let ico = fs::read(&ico_path).expect("Failed to read desktop/assets/app-icon.ico");

    let res_bytes = build_windows_icon_res(&ico);
    let out_dir = PathBuf::from(env::var("OUT_DIR").expect("OUT_DIR"));
    let res_path = out_dir.join("app_icon.res");
    fs::write(&res_path, res_bytes).expect("Failed to write compiled Windows .res icon");

    println!("cargo:rustc-link-arg-bins={}", res_path.display());
}

fn read_u16_le(buf: &[u8], off: usize) -> u16 {
    u16::from_le_bytes([buf[off], buf[off + 1]])
}

fn read_u32_le(buf: &[u8], off: usize) -> u32 {
    u32::from_le_bytes([buf[off], buf[off + 1], buf[off + 2], buf[off + 3]])
}

fn push_res_entry(out: &mut Vec<u8>, res_type: u16, res_id: u16, data: &[u8]) {
    // Standard 32-byte resource header with numeric Type and Name ordinals.
    out.extend_from_slice(&(data.len() as u32).to_le_bytes());
    out.extend_from_slice(&32u32.to_le_bytes());
    out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    out.extend_from_slice(&res_type.to_le_bytes());
    out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    out.extend_from_slice(&res_id.to_le_bytes());
    out.extend_from_slice(&0u32.to_le_bytes()); // DataVersion
    out.extend_from_slice(&0x1030u16.to_le_bytes()); // MemoryFlags: MOVEABLE | PURE | DISCARDABLE
    out.extend_from_slice(&0x0409u16.to_le_bytes()); // LanguageId: en-US
    out.extend_from_slice(&0u32.to_le_bytes()); // Version
    out.extend_from_slice(&0u32.to_le_bytes()); // Characteristics
    out.extend_from_slice(data);

    let pad = (4 - (out.len() % 4)) % 4;
    out.resize(out.len() + pad, 0);
}

fn build_windows_icon_res(ico: &[u8]) -> Vec<u8> {
    assert!(ico.len() >= 6, "Invalid .ico header");
    let reserved = read_u16_le(ico, 0);
    let ico_type = read_u16_le(ico, 2);
    let count = read_u16_le(ico, 4) as usize;
    assert_eq!(reserved, 0, "Invalid .ico reserved field");
    assert_eq!(ico_type, 1, "Expected .ico type == 1");
    assert!(count > 0, "Expected at least one icon image in .ico");
    assert!(ico.len() >= 6 + count * 16, "Truncated .ico directory");

    let mut out = Vec::with_capacity(ico.len() + 256);
    // 32-byte empty RES file signature header.
    out.extend_from_slice(&0u32.to_le_bytes());
    out.extend_from_slice(&32u32.to_le_bytes());
    out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&0xFFFFu16.to_le_bytes());
    out.extend_from_slice(&0u16.to_le_bytes());
    out.extend_from_slice(&[0u8; 16]);

    let mut grp = Vec::with_capacity(6 + count * 14);
    grp.extend_from_slice(&0u16.to_le_bytes()); // idReserved
    grp.extend_from_slice(&1u16.to_le_bytes()); // idType = 1 (icon)
    grp.extend_from_slice(&(count as u16).to_le_bytes());

    for idx in 0..count {
        let dir_off = 6 + idx * 16;
        let width = ico[dir_off];
        let height = ico[dir_off + 1];
        let color_count = ico[dir_off + 2];
        let entry_reserved = ico[dir_off + 3];
        let planes = read_u16_le(ico, dir_off + 4);
        let bit_count = read_u16_le(ico, dir_off + 6);
        let bytes_in_res = read_u32_le(ico, dir_off + 8) as usize;
        let image_offset = read_u32_le(ico, dir_off + 12) as usize;
        assert!(
            image_offset + bytes_in_res <= ico.len(),
            "Truncated .ico image payload"
        );

        let icon_id = (idx + 1) as u16;
        let payload = &ico[image_offset..image_offset + bytes_in_res];
        // RT_ICON = 3
        push_res_entry(&mut out, 3, icon_id, payload);

        grp.push(width);
        grp.push(height);
        grp.push(color_count);
        grp.push(entry_reserved);
        grp.extend_from_slice(&planes.to_le_bytes());
        grp.extend_from_slice(&bit_count.to_le_bytes());
        grp.extend_from_slice(&(bytes_in_res as u32).to_le_bytes());
        grp.extend_from_slice(&icon_id.to_le_bytes());
    }

    // RT_GROUP_ICON = 14, ID = 1 (first icon group becomes default EXE icon)
    push_res_entry(&mut out, 14, 1, &grp);
    out
}
