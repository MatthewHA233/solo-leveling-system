fn main() {
    println!("cargo:rerun-if-changed=tauri.conf.json");

    if let Ok(raw) = std::fs::read_to_string("tauri.conf.json") {
        if let Ok(config) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(product_name) = config.get("productName").and_then(|v| v.as_str()) {
                println!("cargo:rustc-env=SLU_PRODUCT_NAME={product_name}");
            }
        }
    }

    tauri_build::build()
}
