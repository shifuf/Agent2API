//! Stable same-model identity; see the Magpie attribution in THIRD_PARTY_NOTICES.md.
pub fn canonical(model: &str) -> String {
    let lower = model.trim().rsplit('/').next().unwrap_or("").to_lowercase();
    let mut chars = Vec::new();
    for ch in lower.chars() {
        if ch.is_whitespace() || ch == '_' || ch == '-' {
            if !chars.is_empty() && chars.last() != Some(&'-') { chars.push('-'); }
        } else { chars.push(ch); }
    }
    if chars.last() == Some(&'-') { chars.pop(); }
    for i in 1..chars.len().saturating_sub(1) {
        if matches!(chars[i], '.' | 'p') && chars[i - 1].is_ascii_digit() && chars[i + 1].is_ascii_digit() {
            chars[i] = '-';
        }
    }
    let mut result: String = chars.into_iter().collect();
    if let Some(index) = result.rfind(['-', '@']) {
        if index > 0 && snapshot_date(&result[index + 1..]) { result.truncate(index); }
    }
    result
}

fn snapshot_date(value: &str) -> bool {
    if !value.bytes().all(|ch| ch.is_ascii_digit()) { return false; }
    let (year, month, day) = match value.len() {
        8 if value.starts_with("20") => (&value[..4], &value[4..6], &value[6..]),
        6 if ("23"..="39").contains(&&value[..2]) => (&value[..2], &value[2..4], &value[4..]),
        _ => return false,
    };
    let year: u32 = year.parse().unwrap_or(0);
    let month: u32 = month.parse().unwrap_or(0);
    let day: u32 = day.parse().unwrap_or(0);
    let days = match month { 1 | 3 | 5 | 7 | 8 | 10 | 12 => 31, 4 | 6 | 9 | 11 => 30,
        2 if year % 4 == 0 => 29, 2 => 28, _ => return false };
    (1..=days).contains(&day)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vendor_spelling_and_valid_snapshot_dates_converge() {
        for id in [" Anthropic/Claude_Opus_4.5 ", "claude-opus-4p5", "claude-opus-4-5-20251101", "claude-opus-4-5@251101"] {
            assert_eq!(canonical(id), "claude-opus-4-5");
        }
        assert_eq!(canonical("GPT\u{a0}5  Mini"), "gpt-5-mini");
    }
    #[test]
    fn variants_and_fixed_snapshots_stay_distinct() {
        for id in ["qwen-2507", "kimi-k2-0905", "gpt-4o-2024-08-06", "llama-8b:free", "llama-8b:batch", "deepseek-flash", "deepseek-thinking", "m-20251390", "m-261399"] {
            assert_eq!(canonical(id), id);
        }
        assert_ne!(canonical("model:free"), canonical("model"));
        assert_ne!(canonical("a.b"), canonical("a-b"));
        assert_eq!(canonical("中文/模型_1.2"), "模型-1-2");
    }
}
