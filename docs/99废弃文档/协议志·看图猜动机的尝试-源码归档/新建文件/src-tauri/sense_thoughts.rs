// ══════════════════════════════════════════════
// 系统 · 思维终端：感知内核每一步在想什么（看了哪一眼、挑了谁、核实多少分、提了什么假设、问了什么），带耗时
//   只在内存里留最近 300 行（不落盘）；每写一行广播 system:thought，前端的思维终端实时滚动
// ══════════════════════════════════════════════

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use serde::Serialize;
use tauri::{AppHandle, Emitter};

pub const THOUGHT_EVENT: &str = "system:thought";
const KEEP: usize = 300;

#[derive(Clone, Debug, Serialize)]
pub struct Thought {
    pub at_ms: i64,
    /// look / pick / fit / hypo / ask / skip / error
    pub kind: &'static str,
    pub text: String,
    /// 这一步花了多久（没有就是 None）
    pub ms: Option<u64>,
}

fn buffer() -> &'static Mutex<VecDeque<Thought>> {
    static BUF: OnceLock<Mutex<VecDeque<Thought>>> = OnceLock::new();
    BUF.get_or_init(|| Mutex::new(VecDeque::with_capacity(KEEP)))
}

pub fn think(app: &AppHandle, kind: &'static str, text: String, ms: Option<u64>) {
    let line = Thought { at_ms: crate::focus_lock::now_ms(), kind, text, ms };
    {
        let mut buf = buffer().lock().unwrap();
        if buf.len() >= KEEP {
            buf.pop_front();
        }
        buf.push_back(line.clone());
    }
    let _ = app.emit(THOUGHT_EVENT, line);
}

pub fn recent() -> Vec<Thought> {
    buffer().lock().unwrap().iter().cloned().collect()
}
