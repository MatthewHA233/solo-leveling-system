// panic-resolve —— 把 panic.log 里的 RVA 翻译成具体源文件:行号
//
// 用法：
//   1) 翻单个 RVA：
//      cargo run --release -- <pdb-path> 0xRVA [0xRVA ...]
//   2) 从 panic.log 自动抓最近一次 raw stack 翻：
//      cargo run --release -- <pdb-path> --from-log <panic-log-path>
//
// 例：
//   cargo run --release -- \
//     ../../src-tauri/target/x86_64-pc-windows-msvc/debug/Solevup.pdb \
//     --from-log "$env:LOCALAPPDATA/solevup/panic.log"

use std::env;
use std::fs::File;
use std::process::ExitCode;

use pdb_addr2line::{pdb, ContextPdbData};

fn main() -> ExitCode {
    let args: Vec<String> = env::args().collect();
    if args.len() < 3 {
        eprintln!("用法: panic-resolve <pdb> [<0xRVA> ...] | <pdb> --from-log <panic.log>");
        return ExitCode::from(2);
    }
    let pdb_path = &args[1];
    let pdb_file = match File::open(pdb_path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("打开 PDB 失败 ({pdb_path}): {e}");
            return ExitCode::from(1);
        }
    };
    let context_data = match ContextPdbData::try_from_pdb(pdb::PDB::open(pdb_file).unwrap()) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("加载 PDB 失败: {e}");
            return ExitCode::from(1);
        }
    };
    let ctx = match context_data.make_context() {
        Ok(c) => c,
        Err(e) => {
            eprintln!("构建 PDB 上下文失败: {e}");
            return ExitCode::from(1);
        }
    };

    let rvas: Vec<u32> = if args[2] == "--from-log" {
        let log_path = args.get(3).cloned().unwrap_or_else(|| {
            std::env::var("LOCALAPPDATA")
                .map(|p| format!("{}/solevup/panic.log", p))
                .unwrap_or_default()
        });
        match std::fs::read_to_string(&log_path) {
            Ok(content) => extract_latest_rvas(&content),
            Err(e) => {
                eprintln!("读取 panic.log 失败 ({log_path}): {e}");
                return ExitCode::from(1);
            }
        }
    } else {
        args[2..]
            .iter()
            .filter_map(|s| {
                let s = s.trim_start_matches("0x").trim_start_matches("0X");
                u32::from_str_radix(s, 16).ok()
            })
            .collect()
    };

    if rvas.is_empty() {
        eprintln!("没有可解析的 RVA");
        return ExitCode::from(1);
    }

    println!("symbolicating {} RVAs against {}\n", rvas.len(), pdb_path);
    for (i, rva) in rvas.iter().enumerate() {
        match ctx.find_frames(*rva) {
            Ok(Some(frames)) => {
                let inline_count = frames.frames.len();
                for (j, frame) in frames.frames.iter().enumerate() {
                    let fn_name = frame.function.as_deref().unwrap_or("<unknown>");
                    let file = frame.file.as_deref().unwrap_or("<unknown>");
                    let line = frame.line.unwrap_or(0);
                    let marker = if j > 0 { "  (inlined in)" } else { "" };
                    println!(
                        "[{:>2}] 0x{:08x}  {}{}  at {}:{}",
                        i, rva, fn_name, marker, file, line
                    );
                }
                if inline_count == 0 {
                    println!("[{:>2}] 0x{:08x}  <no inline frames>", i, rva);
                }
            }
            Ok(None) => println!("[{:>2}] 0x{:08x}  <not in any procedure>", i, rva),
            Err(e) => println!("[{:>2}] 0x{:08x}  <error: {e}>", i, rva),
        }
    }
    ExitCode::SUCCESS
}

/// 从 panic.log 抓最后一段 "raw stack (module base ..." 后面的 "rva=0xXXXXXXXX" 列表
fn extract_latest_rvas(content: &str) -> Vec<u32> {
    let mut latest_block_start: Option<usize> = None;
    for (i, line) in content.lines().enumerate() {
        if line.contains("raw stack (module base") {
            latest_block_start = Some(i);
        }
    }
    let Some(start) = latest_block_start else { return Vec::new() };
    let lines: Vec<&str> = content.lines().collect();
    let mut rvas = Vec::new();
    for line in &lines[start + 1..] {
        if !line.contains("rva=0x") {
            if line.trim().is_empty() || line.contains("════") {
                break;
            }
            continue;
        }
        if let Some(rva_str) = line.split("rva=0x").nth(1) {
            let rva_str = rva_str.split_whitespace().next().unwrap_or("");
            if let Ok(rva) = u32::from_str_radix(rva_str, 16) {
                rvas.push(rva);
            }
        }
    }
    rvas
}
