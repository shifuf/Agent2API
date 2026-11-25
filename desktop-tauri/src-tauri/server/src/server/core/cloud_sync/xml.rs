//! Small namespace-independent DAV/S3 XML reader; never treats an unparsed response as empty.
pub(crate) fn blocks<'a>(xml: &'a str, tag: &str) -> Result<Vec<&'a str>, String> {
    let expression = format!(r"(?s)<(?:[A-Za-z_][\w.-]*:)?{tag}\b[^>]*>(.*?)</(?:[A-Za-z_][\w.-]*:)?{tag}\s*>");
    let pattern = regex::Regex::new(&expression).map_err(|e|e.to_string())?;
    Ok(pattern.captures_iter(xml).filter_map(|cap|cap.get(1).map(|m|m.as_str())).collect())
}

fn decode_entities(mut value: &str) -> Result<String, String> {
    let mut result = String::new();
    while let Some(at) = value.find('&') {
        result.push_str(&value[..at]);
        let tail = &value[at + 1..];
        let end = tail.find(';').ok_or_else(|| "XML entity has no terminator".to_string())?;
        let entity = &tail[..end];
        let decoded = match entity {
            "amp" => '&', "lt" => '<', "gt" => '>', "quot" => '"', "apos" => '\'',
            _ => {
                let code = if let Some(hex) = entity.strip_prefix("#x").or_else(||entity.strip_prefix("#X")) {
                    u32::from_str_radix(hex, 16).ok()
                } else { entity.strip_prefix('#').and_then(|decimal|decimal.parse::<u32>().ok()) };
                let code = code.filter(|value| matches!(*value, 0x9 | 0xa | 0xd | 0x20..=0xd7ff | 0xe000..=0xfffd | 0x10000..=0x10ffff))
                    .and_then(char::from_u32).ok_or_else(|| "Unsupported or invalid XML entity".to_string())?;
                code
            }
        };
        result.push(decoded);
        value = &tail[end + 1..];
    }
    result.push_str(value);
    Ok(result)
}

fn decode_text(mut value: &str) -> Result<String, String> {
    let mut result = String::new();
    while let Some(at) = value.find("<![CDATA[") {
        result.push_str(&decode_entities(&value[..at])?);
        let tail = &value[at + 9..];
        let end = tail.find("]]>").ok_or_else(|| "Unclosed XML CDATA".to_string())?;
        result.push_str(&tail[..end]);
        value = &tail[end + 3..];
    }
    result.push_str(&decode_entities(value)?);
    Ok(result)
}

pub(crate) fn text(xml: &str, tag: &str) -> Result<Option<String>, String> {
    blocks(xml, tag)?.first().map(|value|decode_text(value.trim())).transpose()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn numeric_entities_are_decoded_once_for_dav_hrefs_and_s3_tokens() {
        assert_eq!(text("<d:href>/history/2026&#45;11&#x2d;25/</d:href>", "href").unwrap().as_deref(), Some("/history/2026-11-25/"));
        assert_eq!(text("<NextContinuationToken>page:2 &amp;&#43;中文</NextContinuationToken>", "NextContinuationToken").unwrap().as_deref(), Some("page:2 &+中文"));
        assert_eq!(text("<Key>&amp;#45;</Key>", "Key").unwrap().as_deref(), Some("&#45;"));
    }
    #[test]
    fn cdata_text_keeps_literal_entities() {
        assert_eq!(text("<Key><![CDATA[page:2 &amp;+中文]]></Key>", "Key").unwrap().as_deref(), Some("page:2 &amp;+中文"));
    }
}
