// ══════════════════════════════════════════════
// 重采样：设备原生采样率（通常 48 kHz）→ 16 kHz，给语音识别用
//
// 做法：先用加窗 sinc 低通滤掉目标奈奎斯特频率以上的成分（防混叠），
// 再按固定步长线性插值取样。流式处理，跨块保留滤波器历史与小数位置。
// 语音识别对这点音质足够，不必引入专门的重采样库。
// ══════════════════════════════════════════════

const TAPS: usize = 31;
/// 截止频率取目标奈奎斯特频率的 90%，给过渡带留余量
const CUTOFF_RATIO: f64 = 0.9;

pub struct Resampler {
    /// 每输出一个样本，在（滤波后的）输入序列上前进多少
    step: f64,
    taps: Vec<f32>,
    /// 上一块末尾的原始输入，接到下一块前面做卷积
    history: Vec<f32>,
    /// 已滤波、尚未被插值消费的样本
    filtered: Vec<f32>,
    /// 下一个输出样本在 filtered 中的位置
    pos: f64,
}

impl Resampler {
    pub fn new(in_rate: u32, out_rate: u32) -> Self {
        let step = in_rate as f64 / out_rate as f64;
        let taps = if in_rate > out_rate {
            lowpass_taps(CUTOFF_RATIO * 0.5 * out_rate as f64 / in_rate as f64)
        } else {
            vec![1.0] // 升采样不会混叠，不需要滤波
        };
        let history = vec![0.0; taps.len() - 1];
        Self { step, taps, history, filtered: Vec::new(), pos: 0.0 }
    }

    /// 处理一块输入，把产出的样本追加到 out
    pub fn process(&mut self, input: &[f32], out: &mut Vec<f32>) {
        let n = self.taps.len();
        let mut ext = std::mem::take(&mut self.history);
        ext.extend_from_slice(input);
        if ext.len() >= n {
            for window in ext.windows(n) {
                let y: f32 = window.iter().zip(&self.taps).map(|(x, t)| x * t).sum();
                self.filtered.push(y);
            }
            self.history = ext[ext.len() - (n - 1)..].to_vec();
        } else {
            self.history = ext;
        }

        while self.pos + 1.0 < self.filtered.len() as f64 {
            let i = self.pos as usize;
            let frac = (self.pos - i as f64) as f32;
            out.push(self.filtered[i] * (1.0 - frac) + self.filtered[i + 1] * frac);
            self.pos += self.step;
        }
        let consumed = (self.pos as usize).min(self.filtered.len());
        self.filtered.drain(..consumed);
        self.pos -= consumed as f64;
    }
}

/// 加 Hamming 窗的 sinc 低通；cutoff 为归一化频率（周期/样本，0~0.5）；系数和为 1（直流增益 1）
fn lowpass_taps(cutoff: f64) -> Vec<f32> {
    let m = (TAPS - 1) as f64;
    let raw: Vec<f64> = (0..TAPS)
        .map(|i| {
            let x = i as f64 - m / 2.0;
            let sinc = if x == 0.0 {
                2.0 * cutoff
            } else {
                (2.0 * std::f64::consts::PI * cutoff * x).sin() / (std::f64::consts::PI * x)
            };
            let window = 0.54 - 0.46 * (2.0 * std::f64::consts::PI * i as f64 / m).cos();
            sinc * window
        })
        .collect();
    let sum: f64 = raw.iter().sum();
    raw.iter().map(|v| (v / sum) as f32).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(freq: f64, rate: u32, secs: f64) -> Vec<f32> {
        let n = (rate as f64 * secs) as usize;
        (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / rate as f64).sin() as f32).collect()
    }

    /// 分多块喂入，模拟录音回调
    fn run(r: &mut Resampler, input: &[f32], block: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for chunk in input.chunks(block) {
            r.process(chunk, &mut out);
        }
        out
    }

    fn rms(x: &[f32]) -> f32 {
        (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt()
    }

    #[test]
    fn output_length_matches_ratio() {
        let mut r = Resampler::new(48_000, 16_000);
        let out = run(&mut r, &sine(440.0, 48_000, 1.0), 480);
        assert!((out.len() as i64 - 16_000).abs() < 40, "len={}", out.len());
    }

    #[test]
    fn keeps_dc_and_speech_band() {
        let mut r = Resampler::new(48_000, 16_000);
        let out = run(&mut r, &vec![0.5; 48_000], 441);
        assert!(out[100..].iter().all(|v| (v - 0.5).abs() < 1e-3));

        let mut r = Resampler::new(48_000, 16_000);
        let out = run(&mut r, &sine(1_000.0, 48_000, 1.0), 512);
        let level = rms(&out[200..]);
        assert!((level - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.03, "1 kHz rms={level}");
    }

    #[test]
    fn suppresses_aliasing() {
        // 12 kHz 高于 16 kHz 采样的奈奎斯特频率，不滤波会混叠成 4 kHz 杂音
        let mut r = Resampler::new(48_000, 16_000);
        let out = run(&mut r, &sine(12_000.0, 48_000, 1.0), 480);
        assert!(rms(&out[200..]) < 0.05, "12 kHz leaked rms={}", rms(&out[200..]));
    }

    #[test]
    fn handles_non_integer_ratio_and_passthrough() {
        let mut r = Resampler::new(44_100, 16_000);
        let out = run(&mut r, &sine(500.0, 44_100, 1.0), 441);
        assert!((out.len() as i64 - 16_000).abs() < 40);
        assert!((rms(&out[200..]) - std::f32::consts::FRAC_1_SQRT_2).abs() < 0.03);

        let mut r = Resampler::new(16_000, 16_000);
        let input = sine(300.0, 16_000, 0.1);
        let out = run(&mut r, &input, 160);
        assert_eq!(&out[..], &input[..out.len()]);
        assert!(input.len() - out.len() <= 1);
    }
}
