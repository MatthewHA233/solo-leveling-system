// 开发用：只有笔记端点的独立小服务。改笔记功能时拿一个临时数据目录跑，
// 不用关掉正在跑的应用，也不会往真实的库里写测试内容。
//
//   cargo xwin build --example notes_dev
//   target/x86_64-pc-windows-msvc/debug/examples/notes_dev.exe <数据目录> [端口，默认 39799]

fn main() {
    let mut args = std::env::args().skip(1);
    let Some(data_dir) = args.next() else {
        eprintln!("用法：notes_dev <数据目录> [端口]");
        std::process::exit(2);
    };
    let port = args.next().and_then(|p| p.parse::<u16>().ok()).unwrap_or(39799);
    if let Err(e) = app_lib::run_notes_dev_server(data_dir.into(), port) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}
