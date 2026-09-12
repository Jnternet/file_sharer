//! 内嵌静态资源：前端文件在编译期进入二进制，运行时不需要任何外部文件（需求 R1）。

use include_dir::{Dir, include_dir};

/// 前端目录在编译期整体嵌入。修改前端文件后需要重新编译（单产物换来的代价）。
static WEB: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/web");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Asset {
    pub path: &'static str,
    pub bytes: &'static [u8],
    pub mime: &'static str,
}

impl Asset {
    pub fn etag(&self) -> String {
        etag(self.bytes)
    }
}

/// 把 URL 路径解析为内嵌资源。
///
/// 只接受规整的相对路径：拒绝空段、`.`、`..`、隐藏文件，避免任何越界读取。
pub fn resolve(url_path: &str) -> Option<Asset> {
    let rel = url_path.trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };

    let safe = rel
        .split('/')
        .all(|seg| !seg.is_empty() && seg != "." && seg != ".." && !seg.starts_with('.'));
    if !safe {
        return None;
    }

    let file = WEB.get_file(rel)?;
    let path = file.path().to_str()?;
    let bytes = file.contents();
    Some(Asset {
        path,
        bytes,
        mime: mime_for(path),
    })
}

/// 首页总是存在；单产物构建的完整性检查。
pub fn index_html() -> Asset {
    resolve("index.html").expect("web/index.html 必须存在（否则单产物无法提供页面）")
}

pub fn mime_for(path: &str) -> &'static str {
    let ext = path.rsplit_once('.').map(|(_, e)| e).unwrap_or("");
    match ext.to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" | "map" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "webmanifest" => "application/manifest+json",
        "woff2" => "font/woff2",
        "txt" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/// 内容指纹：长度 + FNV-1a 64。用于 ETag/条件请求，无需额外依赖。
pub fn etag(bytes: &[u8]) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        hash ^= u64::from(*b);
        hash = hash.wrapping_mul(0x1000_0000_01b3);
    }
    format!("\"{:x}-{:x}\"", bytes.len(), hash)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn index_is_embedded() {
        let asset = index_html();
        assert_eq!(asset.mime, "text/html; charset=utf-8");
        assert!(
            std::str::from_utf8(asset.bytes).unwrap().contains("<html"),
            "内嵌首页应当是 HTML"
        );
    }

    #[test]
    fn root_maps_to_index() {
        assert_eq!(resolve("/").unwrap().path, "index.html");
        assert_eq!(resolve("").unwrap().path, "index.html");
    }

    #[test]
    fn rejects_traversal_and_hidden_files() {
        for bad in [
            "../Cargo.toml",
            "/../Cargo.toml",
            "/a/../../etc/passwd",
            "/.git/config",
            "/a/./b",
            "/a//b",
        ] {
            assert!(resolve(bad).is_none(), "{bad} 必须被拒绝");
        }
    }

    #[test]
    fn missing_file_is_none() {
        assert!(resolve("/nope.js").is_none());
    }

    #[test]
    fn mime_mapping() {
        assert_eq!(mime_for("app.js"), "text/javascript; charset=utf-8");
        assert_eq!(mime_for("lib/sha256.js"), "text/javascript; charset=utf-8");
        assert_eq!(mime_for("styles.css"), "text/css; charset=utf-8");
        assert_eq!(mime_for("index.html"), "text/html; charset=utf-8");
        assert_eq!(mime_for("data.bin"), "application/octet-stream");
        assert_eq!(mime_for("noext"), "application/octet-stream");
    }

    #[test]
    fn etag_is_stable_and_content_sensitive() {
        let a = etag(b"hello");
        assert_eq!(a, etag(b"hello"));
        assert_ne!(a, etag(b"hellp"));
        assert_ne!(a, etag(b"hello!"));
        assert!(a.starts_with('"') && a.ends_with('"'));
    }
}
