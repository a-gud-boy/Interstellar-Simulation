use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Instant;

const MAX_QUERY_SLOTS: u32 = 64;
const RING_LEN: usize = 3;
const HISTORY_LEN: usize = 60;

#[derive(Copy, Clone, Debug, Eq, PartialEq)]
pub enum PassCategory {
    Raymarch,
    Taa,
    Bloom,
    Composite,
}

#[derive(Clone, Debug, Default)]
pub struct PassTimingsSnapshot {
    pub hardware_supported: bool,
    pub raymarch_ms: f32,
    pub taa_ms: f32,
    pub bloom_ms: f32,
    pub composite_ms: f32,
    pub total_ms: f32,
    pub cpu_ms: f32,
    pub history: Vec<f32>,
}

#[derive(Copy, Clone)]
struct RecordedPass {
    category: PassCategory,
    begin_idx: u32,
    end_idx: u32,
}

struct StagingSlot {
    buffer: Arc<wgpu::Buffer>,
    mapped_ready: Arc<AtomicBool>,
    in_flight: bool,
    passes: Vec<RecordedPass>,
    cpu_ms: f32,
}

pub struct GpuPassProfiler {
    enabled: bool,
    hardware_supported: bool,
    timestamp_period_ns: f32,
    query_set: Option<wgpu::QuerySet>,
    resolve_buffer: Option<wgpu::Buffer>,
    ring: Vec<StagingSlot>,

    next_slot: u32,
    frame_passes: Vec<RecordedPass>,
    frame_cpu_start: Instant,
    pending_slot_idx: Option<usize>,

    raymarch_ms: f32,
    taa_ms: f32,
    bloom_ms: f32,
    composite_ms: f32,
    total_ms: f32,
    cpu_ms: f32,
    sample_count: u64,
    history: VecDeque<f32>,
}

impl GpuPassProfiler {
    pub fn new(device: &wgpu::Device, queue: &wgpu::Queue) -> Self {
        let hardware_supported = device.features().contains(wgpu::Features::TIMESTAMP_QUERY);
        let timestamp_period_ns = if hardware_supported {
            queue.get_timestamp_period()
        } else {
            1.0
        };

        let (query_set, resolve_buffer, ring) = if hardware_supported {
            let qs = device.create_query_set(&wgpu::QuerySetDescriptor {
                label: Some("desktop-gpu-profiler-qs"),
                ty: wgpu::QueryType::Timestamp,
                count: MAX_QUERY_SLOTS,
            });
            let rb = device.create_buffer(&wgpu::BufferDescriptor {
                label: Some("desktop-gpu-profiler-resolve"),
                size: (MAX_QUERY_SLOTS as u64) * 8,
                usage: wgpu::BufferUsages::QUERY_RESOLVE | wgpu::BufferUsages::COPY_SRC,
                mapped_at_creation: false,
            });
            let mut ring_slots = Vec::with_capacity(RING_LEN);
            for i in 0..RING_LEN {
                let buf = Arc::new(device.create_buffer(&wgpu::BufferDescriptor {
                    label: Some(&format!("desktop-gpu-profiler-stage-{i}")),
                    size: (MAX_QUERY_SLOTS as u64) * 8,
                    usage: wgpu::BufferUsages::COPY_DST | wgpu::BufferUsages::MAP_READ,
                    mapped_at_creation: false,
                }));
                ring_slots.push(StagingSlot {
                    buffer: buf,
                    mapped_ready: Arc::new(AtomicBool::new(false)),
                    in_flight: false,
                    passes: Vec::new(),
                    cpu_ms: 0.0,
                });
            }
            (Some(qs), Some(rb), ring_slots)
        } else {
            (None, None, Vec::new())
        };

        Self {
            enabled: false,
            hardware_supported,
            timestamp_period_ns,
            query_set,
            resolve_buffer,
            ring,
            next_slot: 0,
            frame_passes: Vec::new(),
            frame_cpu_start: Instant::now(),
            pending_slot_idx: None,
            raymarch_ms: 0.0,
            taa_ms: 0.0,
            bloom_ms: 0.0,
            composite_ms: 0.0,
            total_ms: 0.0,
            cpu_ms: 0.0,
            sample_count: 0,
            history: VecDeque::with_capacity(HISTORY_LEN),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    pub fn set_enabled(&mut self, enabled: bool) {
        self.enabled = enabled;
    }

    pub fn begin_frame(&mut self) {
        self.poll_completed();
        self.next_slot = 0;
        self.frame_passes.clear();
        self.pending_slot_idx = None;
        self.frame_cpu_start = Instant::now();
    }

    pub fn timestamp_writes_for(
        &mut self,
        category: PassCategory,
    ) -> Option<wgpu::RenderPassTimestampWrites<'_>> {
        if !self.enabled || !self.hardware_supported {
            return None;
        }
        let qs = self.query_set.as_ref()?;
        if self.next_slot + 2 > MAX_QUERY_SLOTS {
            return None;
        }
        let begin_idx = self.next_slot;
        let end_idx = self.next_slot + 1;
        self.next_slot += 2;
        self.frame_passes.push(RecordedPass {
            category,
            begin_idx,
            end_idx,
        });
        Some(wgpu::RenderPassTimestampWrites {
            query_set: qs,
            beginning_of_pass_write_index: Some(begin_idx),
            end_of_pass_write_index: Some(end_idx),
        })
    }

    pub fn end_frame(&mut self, encoder: &mut wgpu::CommandEncoder) {
        if !self.enabled {
            return;
        }
        let cpu_ms = self.frame_cpu_start.elapsed().as_secs_f32() * 1000.0;
        if !self.hardware_supported || self.frame_passes.is_empty() {
            self.push_sample(0.0, 0.0, 0.0, 0.0, cpu_ms);
            return;
        }
        let Some(qs) = self.query_set.as_ref() else {
            return;
        };
        let Some(rb) = self.resolve_buffer.as_ref() else {
            return;
        };
        let Some(slot_idx) = self.ring.iter().position(|s| !s.in_flight) else {
            return;
        };

        let count = self.next_slot;
        encoder.resolve_query_set(qs, 0..count, rb, 0);
        encoder.copy_buffer_to_buffer(rb, 0, &self.ring[slot_idx].buffer, 0, (count as u64) * 8);

        let slot = &mut self.ring[slot_idx];
        slot.passes.clear();
        slot.passes.extend_from_slice(&self.frame_passes);
        slot.cpu_ms = cpu_ms;
        slot.in_flight = true;
        slot.mapped_ready.store(false, Ordering::Release);
        self.pending_slot_idx = Some(slot_idx);
    }

    pub fn after_submit(&mut self) {
        let Some(slot_idx) = self.pending_slot_idx.take() else {
            return;
        };
        let slot = &self.ring[slot_idx];
        let ready_flag = slot.mapped_ready.clone();
        slot.buffer
            .slice(..)
            .map_async(wgpu::MapMode::Read, move |res| {
                if res.is_ok() {
                    ready_flag.store(true, Ordering::Release);
                }
            });
    }

    fn poll_completed(&mut self) {
        if !self.hardware_supported {
            return;
        }
        let period = self.timestamp_period_ns as f64 * 1e-6;
        let mut completed: Vec<(f32, f32, f32, f32, f32)> = Vec::new();

        for slot in &mut self.ring {
            if !slot.in_flight || !slot.mapped_ready.load(Ordering::Acquire) {
                continue;
            }
            let mut rm = 0.0_f64;
            let mut taa = 0.0_f64;
            let mut bl = 0.0_f64;
            let mut comp = 0.0_f64;
            if let Ok(view) = slot.buffer.slice(..).get_mapped_range() {
                let timestamps: &[u64] = bytemuck::cast_slice(&view);
                for p in &slot.passes {
                    let b = timestamps.get(p.begin_idx as usize).copied().unwrap_or(0);
                    let e = timestamps.get(p.end_idx as usize).copied().unwrap_or(0);
                    if e >= b {
                        let ms = ((e - b) as f64) * period;
                        if ms < 500.0 {
                            match p.category {
                                PassCategory::Raymarch => rm += ms,
                                PassCategory::Taa => taa += ms,
                                PassCategory::Bloom => bl += ms,
                                PassCategory::Composite => comp += ms,
                            }
                        }
                    }
                }
            }
            slot.buffer.unmap();
            slot.mapped_ready.store(false, Ordering::Release);
            slot.in_flight = false;
            completed.push((rm as f32, taa as f32, bl as f32, comp as f32, slot.cpu_ms));
        }

        for (rm, taa, bl, comp, cpu) in completed {
            self.push_sample(rm, taa, bl, comp, cpu);
        }
    }

    fn push_sample(&mut self, rm: f32, taa: f32, bl: f32, comp: f32, cpu: f32) {
        let total = rm + taa + bl + comp;
        let alpha = if self.sample_count == 0 { 1.0 } else { 0.18 };
        self.raymarch_ms += (rm - self.raymarch_ms) * alpha;
        self.taa_ms += (taa - self.taa_ms) * alpha;
        self.bloom_ms += (bl - self.bloom_ms) * alpha;
        self.composite_ms += (comp - self.composite_ms) * alpha;
        self.total_ms += (total - self.total_ms) * alpha;
        self.cpu_ms += (cpu - self.cpu_ms) * alpha;
        self.sample_count += 1;

        if self.history.len() >= HISTORY_LEN {
            self.history.pop_front();
        }
        self.history
            .push_back(if self.hardware_supported { total } else { cpu });
    }

    pub fn snapshot(&self) -> PassTimingsSnapshot {
        PassTimingsSnapshot {
            hardware_supported: self.hardware_supported,
            raymarch_ms: self.raymarch_ms,
            taa_ms: self.taa_ms,
            bloom_ms: self.bloom_ms,
            composite_ms: self.composite_ms,
            total_ms: if self.hardware_supported {
                self.total_ms
            } else {
                self.cpu_ms
            },
            cpu_ms: self.cpu_ms,
            history: self.history.iter().copied().collect(),
        }
    }
}
