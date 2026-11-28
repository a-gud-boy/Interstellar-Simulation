use std::fs;
use std::path::{Path, PathBuf};
use std::sync::mpsc::{self, SyncSender};
use std::thread::JoinHandle;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum RecorderMode {
    Live,
    Turntable,
    Evolution,
}

impl RecorderMode {
    pub fn as_i32(self) -> i32 {
        match self {
            RecorderMode::Live => 0,
            RecorderMode::Turntable => 1,
            RecorderMode::Evolution => 2,
        }
    }

    pub fn from_i32(v: i32) -> Self {
        match v {
            0 => RecorderMode::Live,
            2 => RecorderMode::Evolution,
            _ => RecorderMode::Turntable,
        }
    }

    pub fn slug(self) -> &'static str {
        match self {
            RecorderMode::Live => "live",
            RecorderMode::Turntable => "turntable",
            RecorderMode::Evolution => "evolution",
        }
    }
}

struct FrameJob {
    path: PathBuf,
    width: u32,
    height: u32,
    rgba: Vec<u8>,
}

pub struct CinemaRecorder {
    pub mode: RecorderMode,
    pub fps: u32,
    pub duration_sec: u32,
    pub frame_index: u32,
    pub total_frames: u32,
    pub output_dir: PathBuf,
    tx: Option<SyncSender<FrameJob>>,
    worker: Option<JoinHandle<()>>,
}

impl CinemaRecorder {
    pub fn start(
        base_dir: &Path,
        sim_slug: &str,
        mode: RecorderMode,
        fps: u32,
        duration_sec: u32,
    ) -> std::io::Result<Self> {
        let safe_fps = fps.clamp(15, 60);
        let safe_dur = duration_sec.clamp(2, 30);
        let total_frames = (safe_fps * safe_dur).clamp(2, 600);
        let ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let output_dir = base_dir.join(format!("{}_{}_{}", sim_slug, mode.slug(), ts));
        fs::create_dir_all(&output_dir)?;

        let manifest = format!(
            "sim={sim_slug}\n\
             mode={}\n\
             fps={safe_fps}\n\
             duration_sec={safe_dur}\n\
             planned_frames={total_frames}\n\
             ffmpeg=ffmpeg -framerate {safe_fps} -i frame_%04d.png -c:v libx264 -crf 16 -pix_fmt yuv420p {sim_slug}-{}.mp4\n",
            mode.slug(),
            mode.slug()
        );
        fs::write(output_dir.join("manifest.txt"), manifest)?;

        let (tx, rx) = mpsc::sync_channel::<FrameJob>(4);
        let worker = std::thread::spawn(move || {
            while let Ok(job) = rx.recv() {
                if let Err(err) = image::save_buffer(
                    &job.path,
                    &job.rgba,
                    job.width,
                    job.height,
                    image::ColorType::Rgba8,
                ) {
                    eprintln!(
                        "[interstellar-desktop] Failed writing {}: {err}",
                        job.path.display()
                    );
                }
            }
        });

        Ok(Self {
            mode,
            fps: safe_fps,
            duration_sec: safe_dur,
            frame_index: 0,
            total_frames,
            output_dir,
            tx: Some(tx),
            worker: Some(worker),
        })
    }

    pub fn fixed_dt(&self) -> f32 {
        1.0 / self.fps.max(1) as f32
    }

    pub fn progress_u(&self) -> f32 {
        if self.total_frames <= 1 {
            return 1.0;
        }
        (self.frame_index as f32 / (self.total_frames - 1) as f32).clamp(0.0, 1.0)
    }

    pub fn turntable_drag_delta(&self, viewport_w: f32, viewport_h: f32) -> f32 {
        let min_dim = viewport_w.min(viewport_h).max(320.0);
        (std::f32::consts::TAU / 3.0) * min_dim / self.total_frames.max(1) as f32
    }

    pub fn push_frame(&mut self, width: u32, height: u32, rgba: Vec<u8>) -> bool {
        self.frame_index += 1;
        let path = self
            .output_dir
            .join(format!("frame_{:04}.png", self.frame_index));
        if let Some(tx) = &self.tx {
            let _ = tx.send(FrameJob {
                path,
                width,
                height,
                rgba,
            });
        }
        self.frame_index >= self.total_frames
    }

    pub fn finish(mut self) -> (PathBuf, u32) {
        self.tx.take();
        if let Some(handle) = self.worker.take() {
            let _ = handle.join();
        }
        (self.output_dir, self.frame_index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recorder_turntable_delta_sums_to_full_orbit() {
        let mut rec = CinemaRecorder {
            mode: RecorderMode::Turntable,
            fps: 30,
            duration_sec: 4,
            frame_index: 0,
            total_frames: 120,
            output_dir: PathBuf::from("."),
            tx: None,
            worker: None,
        };
        let dx = rec.turntable_drag_delta(1280.0, 720.0);
        let scale = 1.0 / 720.0;
        let total_az = dx * scale * 3.0 * rec.total_frames as f32;
        assert!((total_az - std::f32::consts::TAU).abs() < 1e-3);
        assert!((rec.fixed_dt() - 1.0 / 30.0).abs() < 1e-5);
        assert!(!rec.push_frame(2, 2, vec![0; 16]));
        assert_eq!(rec.frame_index, 1);
    }
}
