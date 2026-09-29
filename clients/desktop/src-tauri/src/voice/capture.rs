// ══════════════════════════════════════════════
// 原生麦克风采集（cpal：Windows WASAPI / macOS CoreAudio）
//
// 专用线程持有 cpal Stream（部分平台的 Stream 不能跨线程），录音回调里完成
// 下混单声道 → 重采样到 16 kHz → 切 100 ms 一块 → 算音量，通过通道交给会话编排。
// 停止时先多录一小段尾巴再停，免得吞掉松手前最后一个字。
// ══════════════════════════════════════════════

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, SampleFormat, SizedSample};
use tokio::sync::mpsc::UnboundedSender;

use super::resample::Resampler;

pub const TARGET_RATE: u32 = 16_000;
/// 每块 100 ms
pub const CHUNK_SAMPLES: usize = 1_600;
/// 松手后多录的尾巴
const TAIL: Duration = Duration::from_millis(250);
const POLL: Duration = Duration::from_millis(10);

pub struct CaptureInfo {
    pub device: String,
    pub sample_rate: u32,
    pub channels: u16,
    pub format: String,
    pub open_ms: u64,
}

pub enum CaptureEvent {
    Ready(CaptureInfo),
    /// 16 kHz 单声道 PCM16 一块，附 0~1 的音量（RMS）
    Chunk { pcm: Vec<i16>, level: f32 },
    Error(String),
}

pub struct CaptureHandle {
    stop: Arc<AtomicBool>,
}

impl CaptureHandle {
    /// 请求停止：线程再录 TAIL 后冲刷剩余样本并退出，事件通道随之关闭（接收端收到 None）
    pub fn request_stop(&self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

impl Drop for CaptureHandle {
    /// 只置停止标志、不 join：线程几百毫秒内自行退出，别在异步任务里阻塞等它
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
    }
}

/// 起录音线程；线程起不来时事件通道会直接关闭，调用方按「没录到声音」处理
pub fn start(tx: UnboundedSender<CaptureEvent>) -> CaptureHandle {
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let spawned = std::thread::Builder::new().name("voice-capture".into()).spawn(move || {
        if let Err(e) = run(&tx, &stop_flag) {
            let _ = tx.send(CaptureEvent::Error(e));
        }
    });
    if let Err(e) = spawned {
        log::error!("[Voice] 录音线程启动失败: {e}");
    }
    CaptureHandle { stop }
}

fn run(tx: &UnboundedSender<CaptureEvent>, stop: &Arc<AtomicBool>) -> Result<(), String> {
    let t0 = Instant::now();
    let host = cpal::default_host();
    let device = host
        .default_input_device()
        .ok_or_else(|| "没有找到可用的麦克风".to_string())?;
    let device_name = device
        .description()
        .map(|d| d.name().to_string())
        .unwrap_or_else(|_| "默认麦克风".to_string());
    let supported = device.default_input_config().map_err(describe)?;
    let config = supported.config();
    let format = supported.sample_format();

    // 回调线程 → 本线程：尾巴冲刷完成的信号
    let flushed = Arc::new(AtomicBool::new(false));
    let chunker = Chunker::new(config.sample_rate, config.channels, tx.clone(), stop.clone(), flushed.clone());
    let err_tx = tx.clone();
    let on_error = move |e: cpal::Error| {
        let _ = err_tx.send(CaptureEvent::Error(describe(e)));
    };

    let stream = match format {
        SampleFormat::F32 => build::<f32>(&device, config.clone(), chunker, on_error),
        SampleFormat::I16 => build::<i16>(&device, config.clone(), chunker, on_error),
        SampleFormat::I32 => build::<i32>(&device, config.clone(), chunker, on_error),
        SampleFormat::U16 => build::<u16>(&device, config.clone(), chunker, on_error),
        SampleFormat::U8 => build::<u8>(&device, config.clone(), chunker, on_error),
        SampleFormat::F64 => build::<f64>(&device, config.clone(), chunker, on_error),
        other => return Err(format!("麦克风的采样格式 {other:?} 暂不支持")),
    }?;
    stream.play().map_err(describe)?;

    let _ = tx.send(CaptureEvent::Ready(CaptureInfo {
        device: device_name,
        sample_rate: config.sample_rate,
        channels: config.channels,
        format: format!("{format:?}"),
        open_ms: t0.elapsed().as_millis() as u64,
    }));

    while !stop.load(Ordering::SeqCst) {
        std::thread::sleep(POLL);
    }
    // 松手后再录一小段尾巴；回调看到 stop 后会把不足一块的剩余样本也发出去
    let tail_deadline = Instant::now() + TAIL + Duration::from_millis(200);
    while !flushed.load(Ordering::SeqCst) && Instant::now() < tail_deadline {
        std::thread::sleep(POLL);
    }
    drop(stream);
    Ok(())
}

fn build<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    mut chunker: Chunker,
    on_error: impl FnMut(cpal::Error) + Send + 'static,
) -> Result<cpal::Stream, String>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    device
        .build_input_stream::<T, _, _>(
            config,
            move |data: &[T], _| chunker.push(data.iter().map(|s| s.to_sample::<f32>())),
            on_error,
            None,
        )
        .map_err(describe)
}

/// 录音回调里的状态：下混 → 重采样 → 切块
struct Chunker {
    channels: usize,
    resampler: Resampler,
    mono: Vec<f32>,
    resampled: Vec<f32>,
    pending: Vec<f32>,
    tx: UnboundedSender<CaptureEvent>,
    stop: Arc<AtomicBool>,
    stop_seen_at: Option<Instant>,
    flushed: Arc<AtomicBool>,
}

impl Chunker {
    fn new(
        rate: u32,
        channels: u16,
        tx: UnboundedSender<CaptureEvent>,
        stop: Arc<AtomicBool>,
        flushed: Arc<AtomicBool>,
    ) -> Self {
        Self {
            channels: channels.max(1) as usize,
            resampler: Resampler::new(rate, TARGET_RATE),
            mono: Vec::new(),
            resampled: Vec::new(),
            pending: Vec::with_capacity(CHUNK_SAMPLES * 2),
            tx,
            stop,
            stop_seen_at: None,
            flushed,
        }
    }

    fn push(&mut self, interleaved: impl Iterator<Item = f32>) {
        if self.flushed.load(Ordering::Relaxed) {
            return;
        }
        self.mono.clear();
        let mut acc = 0.0;
        for (i, s) in interleaved.enumerate() {
            acc += s;
            if (i + 1) % self.channels == 0 {
                self.mono.push(acc / self.channels as f32);
                acc = 0.0;
            }
        }
        self.resampled.clear();
        self.resampler.process(&self.mono, &mut self.resampled);
        self.pending.extend_from_slice(&self.resampled);
        while self.pending.len() >= CHUNK_SAMPLES {
            let rest = self.pending.split_off(CHUNK_SAMPLES);
            let block = std::mem::replace(&mut self.pending, rest);
            self.emit(&block);
        }

        if self.stop.load(Ordering::Relaxed) {
            let seen = *self.stop_seen_at.get_or_insert_with(Instant::now);
            if seen.elapsed() >= TAIL {
                let block = std::mem::take(&mut self.pending);
                if !block.is_empty() {
                    self.emit(&block);
                }
                self.flushed.store(true, Ordering::SeqCst);
            }
        }
    }

    fn emit(&self, block: &[f32]) {
        let level = (block.iter().map(|v| v * v).sum::<f32>() / block.len() as f32).sqrt();
        let pcm = block.iter().map(|v| (v.clamp(-1.0, 1.0) * i16::MAX as f32) as i16).collect();
        let _ = self.tx.send(CaptureEvent::Chunk { pcm, level: level.min(1.0) });
    }
}

/// cpal 错误 → 给用户看的中文说明
fn describe(e: cpal::Error) -> String {
    use cpal::ErrorKind::*;
    let hint = match e.kind() {
        PermissionDenied => "麦克风权限被拒绝：请在系统设置 → 隐私 → 麦克风里允许桌面应用使用麦克风",
        DeviceBusy => "麦克风被其他程序独占，请关掉占用它的程序再试",
        DeviceNotAvailable | DeviceChanged => "麦克风不可用或刚被拔出，请检查设备",
        _ => "打开麦克风失败",
    };
    format!("{hint}（{e}）")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 真机测试（需要麦克风）：cargo 测试时加 --ignored 手动运行，看开麦耗时与数据是否正常
    #[test]
    #[ignore]
    fn opens_real_microphone() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let t0 = Instant::now();
        let handle = start(tx);
        let mut chunks = 0usize;
        let mut peak = 0f32;
        let mut ready_ms = None;
        while t0.elapsed() < Duration::from_secs(4) {
            match rx.try_recv() {
                Ok(CaptureEvent::Ready(info)) => {
                    ready_ms = Some(t0.elapsed().as_millis());
                    println!("就绪 {}ms（线程内 {}ms）: {} {}Hz {}ch {}", t0.elapsed().as_millis(), info.open_ms, info.device, info.sample_rate, info.channels, info.format);
                }
                Ok(CaptureEvent::Chunk { pcm, level }) => {
                    if chunks < 10 {
                        assert_eq!(pcm.len(), CHUNK_SAMPLES); // 停止后冲刷的尾巴可以不足一块
                    }
                    chunks += 1;
                    peak = peak.max(level);
                    if chunks == 10 {
                        handle.request_stop();
                    }
                }
                Ok(CaptureEvent::Error(e)) => panic!("录音出错: {e}"),
                Err(tokio::sync::mpsc::error::TryRecvError::Disconnected) => break,
                Err(_) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        println!("收到 {chunks} 块，峰值音量 {peak:.4}，共 {}ms", t0.elapsed().as_millis());
        assert!(ready_ms.is_some(), "麦克风没有就绪");
        assert!(chunks >= 10, "块数太少: {chunks}");
    }
}
