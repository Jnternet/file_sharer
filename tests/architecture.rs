//! 架构测试：把"每次启动都是空桶"和"服务器不接收文件字节"两条需求
//! 变成可执行的约束 —— 以后任何人不小心加上落盘代码/上传路由都会红。

use std::fs;
use std::path::{Path, PathBuf};

fn rust_sources() -> Vec<(PathBuf, String)> {
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    for entry in fs::read_dir(&src).expect("src 目录存在") {
        let path = entry.unwrap().path();
        if path.extension().is_some_and(|e| e == "rs") {
            let text = fs::read_to_string(&path).unwrap();
            out.push((path, text));
        }
    }
    assert!(!out.is_empty(), "应当至少有一个源文件");
    out
}

/// 去掉 `#[cfg(test)]` 之后的内容，只审查真正会进二进制的代码。
fn production_part(text: &str) -> String {
    match text.find("#[cfg(test)]") {
        Some(idx) => text[..idx].to_string(),
        None => text.to_string(),
    }
}

#[test]
fn server_never_writes_to_disk() {
    const BANNED: &[&str] = &[
        "std::fs",
        "tokio::fs",
        "fs::write",
        "fs::create",
        "fs::remove",
        "fs::rename",
        "File::create",
        "File::open",
        "OpenOptions",
        "create_dir",
        "tempfile",
    ];
    for (path, text) in rust_sources() {
        let production = production_part(&text);
        for pattern in BANNED {
            assert!(
                !production.contains(pattern),
                "{} 中出现了落盘相关调用 `{pattern}`：服务器必须零存储",
                path.display()
            );
        }
    }
}

#[test]
fn server_only_exposes_read_routes() {
    let lib = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/lib.rs");
    let text = fs::read_to_string(&lib).unwrap();
    for banned in [
        "post(",
        "put(",
        "patch(",
        "delete(",
        "Multipart",
        "BodyLimit",
    ] {
        assert!(
            !text.contains(banned),
            "src/lib.rs 不应包含写路由/请求体处理 `{banned}`：文件字节必须走 P2P"
        );
    }
    assert!(text.contains("get("), "静态与 API 路由应当使用 GET");
}

#[test]
fn server_knows_nothing_about_files() {
    // 需求：服务器不记录、不留存。协议层不得出现任何文件概念。
    const BANNED: &[&str] = &[
        "sha256",
        "manifest",
        "fileindex",
        "chunk",
        "filename",
        "filesize",
        "share",
        "transfer",
        "path",
    ];
    // 只看协议/转发层：这里不应出现任何文件语义
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for name in ["signal.rs", "ws.rs"] {
        let text = production_part(&fs::read_to_string(root.join(name)).unwrap()).to_lowercase();
        for pattern in BANNED {
            assert!(
                !text.contains(pattern),
                "src/{name} 出现了文件相关概念 `{pattern}`：服务器只转发，不记录文件"
            );
        }
    }
}

#[test]
fn server_never_broadcasts() {
    // 需求：不广播。服务器代码里不应存在任何"广播/群发"的实现。
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    for entry in fs::read_dir(&root).unwrap() {
        let path = entry.unwrap().path();
        let text = production_part(&fs::read_to_string(&path).unwrap()).to_lowercase();
        for pattern in ["broadcast", "for_each_session", "send_all", "fan_out"] {
            assert!(
                !text.contains(pattern),
                "{} 中出现了广播语义 `{pattern}`：本项目不广播",
                path.display()
            );
        }
    }
}

#[test]
fn frontend_assets_are_embedded_for_single_artifact_build() {
    let assets = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/assets.rs");
    let text = fs::read_to_string(&assets).unwrap();
    assert!(
        text.contains("include_dir!("),
        "前端必须编译期内嵌，才能保证单产物"
    );
    assert!(
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("web/index.html")
            .exists(),
        "web/index.html 必须存在"
    );
}
