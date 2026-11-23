//! HTML asset rewriting adapted from upstream a4ea2c11; disk-only hosting.
use super::is_api_path;

pub(super) fn rewrite_html_assets(html: &[u8], resolve_stamp: &dyn Fn(&[&str]) -> String) -> Vec<u8> {
    let Ok(text) = std::str::from_utf8(html) else {
        return html.to_vec();
    };
    let mut out = String::with_capacity(text.len() + 512);
    let mut i = 0;

    while i < text.len() {
        let Some(rel_lt) = text[i..].find('<') else {
            out.push_str(&text[i..]);
            break;
        };
        let lt = i + rel_lt;
        out.push_str(&text[i..lt]);
        let rest = &text[lt..];

        if rest.starts_with("<!--") {
            if let Some(comment_end) = rest[4..].find("-->") {
                let end = 4 + comment_end + 3;
                out.push_str(&rest[..end]);
                i = lt + end;
                continue;
            }
        }

        if let Some((tag_name, after_name)) = match_asset_tag_start(rest) {
            if let Some(tag_end) = find_tag_end(rest, after_name) {
                let tag_slice = &rest[..=tag_end];
                let attr_name = if tag_name == "link" { "href" } else { "src" };
                out.push_str(&rewrite_tag_attr(tag_slice, after_name, attr_name, resolve_stamp));
                i = lt + tag_end + 1;

                if tag_name == "script" {
                    if let Some(close_offset) = find_ascii_ci(&text[i..], "</script") {
                        let body_end = i + close_offset;
                        out.push_str(&rewrite_inline_i18n_scripts(&text[i..body_end], resolve_stamp));
                        i = body_end;
                    }
                }
                continue;
            }
        } else if let Some(after_style) = starts_with_tag_ci(rest, "style") {
            if let Some(tag_end) = find_tag_end(rest, after_style) {
                out.push_str(&rest[..=tag_end]);
                i = lt + tag_end + 1;
                if let Some(close_offset) = find_ascii_ci(&text[i..], "</style") {
                    let body_end = i + close_offset;
                    out.push_str(&text[i..body_end]);
                    i = body_end;
                }
                continue;
            }
        }

        out.push('<');
        i = lt + 1;
    }

    out.into_bytes()
}

fn match_asset_tag_start(slice: &str) -> Option<(&'static str, usize)> {
    for tag in ["script", "link", "img"] {
        if let Some(offset) = starts_with_tag_ci(slice, tag) {
            return Some((tag, offset));
        }
    }
    None
}

fn starts_with_tag_ci(slice: &str, tag: &str) -> Option<usize> {
    let bytes = slice.as_bytes();
    let tag_bytes = tag.as_bytes();
    let prefix_len = 1 + tag_bytes.len();
    if bytes.len() <= prefix_len || bytes[0] != b'<' {
        return None;
    }
    if !bytes[1..prefix_len].eq_ignore_ascii_case(tag_bytes) {
        return None;
    }
    let boundary = bytes[prefix_len];
    (boundary.is_ascii_whitespace() || matches!(boundary, b'>' | b'/')).then_some(prefix_len)
}

fn find_tag_end(slice: &str, start: usize) -> Option<usize> {
    let bytes = slice.as_bytes();
    let mut pos = start;
    let mut quote: Option<u8> = None;
    while pos < bytes.len() {
        let ch = bytes[pos];
        if let Some(q) = quote {
            if ch == q {
                quote = None;
            }
        } else if ch == b'"' || ch == b'\'' {
            quote = Some(ch);
        } else if ch == b'>' {
            return Some(pos);
        }
        pos += 1;
    }
    None
}

fn find_ascii_ci(haystack: &str, ascii_needle: &str) -> Option<usize> {
    haystack
        .as_bytes()
        .windows(ascii_needle.len())
        .position(|win| win.eq_ignore_ascii_case(ascii_needle.as_bytes()))
}

fn rewrite_tag_attr(
    tag: &str,
    attr_offset: usize,
    target_attr: &str,
    resolve_stamp: &dyn Fn(&[&str]) -> String,
) -> String {
    let bytes = tag.as_bytes();
    let end = tag.len().saturating_sub(1);
    let mut pos = attr_offset;
    let mut out = String::with_capacity(tag.len() + 32);
    let mut copied = 0;

    while pos < end {
        while pos < end && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        if pos >= end || bytes[pos] == b'>' {
            break;
        }
        if bytes[pos] == b'/' {
            pos += 1;
            continue;
        }
        let name_start = pos;
        while pos < end
            && !bytes[pos].is_ascii_whitespace()
            && !matches!(bytes[pos], b'=' | b'>' | b'/')
        {
            pos += 1;
        }
        if pos == name_start {
            pos += 1;
            continue;
        }
        let name = &tag[name_start..pos];
        while pos < end && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        if pos >= end || bytes[pos] != b'=' {
            continue;
        }
        pos += 1;
        while pos < end && bytes[pos].is_ascii_whitespace() {
            pos += 1;
        }
        if pos >= end {
            break;
        }

        let (val_start, val_end) = if matches!(bytes[pos], b'"' | b'\'') {
            let q = bytes[pos];
            pos += 1;
            let vs = pos;
            while pos < end && bytes[pos] != q {
                pos += 1;
            }
            let ve = pos;
            if pos < end && bytes[pos] == q {
                pos += 1;
            }
            (vs, ve)
        } else {
            let vs = pos;
            while pos < end && !bytes[pos].is_ascii_whitespace() && bytes[pos] != b'>' {
                pos += 1;
            }
            (vs, pos)
        };

        if name.eq_ignore_ascii_case(target_attr) {
            let url = &tag[val_start..val_end];
            if should_version_asset_url(url) {
                let stamp = resolve_stamp(&[url]);
                out.push_str(&tag[copied..val_start]);
                out.push_str(&versioned_url(url, &stamp));
                copied = val_end;
            }
        }
    }

    out.push_str(&tag[copied..]);
    out
}

fn rewrite_inline_i18n_scripts(body: &str, resolve_stamp: &dyn Fn(&[&str]) -> String) -> String {
    const PREFIX: &str = "src=\"i18n/";
    const SUFFIX: &str = ".js\"><\\/script>";
    let mut out = String::with_capacity(body.len() + 64);
    let mut cursor = 0;

    while let Some(rel) = body[cursor..].find(PREFIX) {
        let val_start = cursor + rel + 5;
        let line_end = body[val_start..]
            .find('\n')
            .map_or(body.len(), |n| val_start + n)
            .min(val_start.saturating_add(200));
        let Some(marker_rel) = body[val_start..line_end].find(SUFFIX) else {
            out.push_str(&body[cursor..val_start]);
            cursor = val_start;
            continue;
        };
        let snippet = &body[val_start..val_start + marker_rel];
        let insert_at = val_start + marker_rel + 3; // 保留 ".js"，在其后插入 "?v=..."
        let stamp = resolve_i18n_snippet_stamp(snippet, resolve_stamp);
        out.push_str(&body[cursor..insert_at]);
        out.push_str("?v=");
        out.push_str(&stamp);
        cursor = insert_at;
    }

    out.push_str(&body[cursor..]);
    out
}

fn resolve_i18n_snippet_stamp(
    snippet: &str,
    resolve_stamp: &dyn Fn(&[&str]) -> String,
) -> String {
    if snippet.starts_with("i18n/combined/") {
        return resolve_stamp(&[
            "i18n/combined/zh-CN.js",
            "i18n/combined/en.js",
            "i18n.js",
        ]);
    }
    if let Some(page) = snippet.rsplit('/').next() {
        let valid_name = !page.is_empty()
            && page
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'));
        if valid_name {
            let zh = format!("i18n/zh-CN/{page}.js");
            let en = format!("i18n/en/{page}.js");
            return resolve_stamp(&[zh.as_str(), en.as_str(), "i18n.js"]);
        }
    }
    resolve_stamp(&["i18n.js"])
}

fn should_version_asset_url(url: &str) -> bool {
    let trimmed = url.trim();
    if trimmed.is_empty()
        || trimmed.starts_with('#')
        || trimmed.starts_with("//")

    {
        return false;
    }
    let lower = trimmed.to_ascii_lowercase();
    if lower.starts_with("http://")
        || lower.starts_with("https://")
        || lower.starts_with("data:")
        || lower.starts_with("blob:")
        || lower.starts_with("mailto:")
        || lower.starts_with("javascript:")
    {
        return false;
    }
    let asset_path = trimmed.split(['?', '#']).next().unwrap_or("");
    if is_api_path(asset_path) {
        return false;
    }
    asset_path
        .rsplit('/')
        .next()
        .is_some_and(|segment| segment.contains('.'))
}

/// `If-None-Match` 的匹配：支持 `*`、列表与弱校验前缀（`W/`）。
///
/// 两边都按弱比较（去掉 `W/`）处理：同一份文件的 gzip 与未压缩正文共用
/// 这个 ETag，弱校验正是「语义相同、字节可能不同」的表达。
fn versioned_url(url: &str, stamp: &str) -> String {
    let (base, fragment) = url.split_once('#').map_or((url, None), |(base, fragment)| (base, Some(fragment)));
    let (base, query) = base.split_once('?').unwrap_or((base, ""));
    let query = query.replace("&amp;", "&");
    let mut parameters = query.split('&').filter(|part| !part.is_empty() && part.split('=').next() != Some("v")).map(str::to_owned).collect::<Vec<_>>();
    parameters.push(format!("v={stamp}"));
    let mut out = format!("{base}?{}", parameters.join("&"));
    if let Some(fragment) = fragment { out.push('#'); out.push_str(fragment); }
    out
}
