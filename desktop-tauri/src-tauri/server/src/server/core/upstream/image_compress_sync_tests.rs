use super::*;
use serde_json::json;

#[test]
fn upstream_sync_multiple_images_keep_positions_formats_and_statistics() {
    let pixels = image::RgbImage::from_fn(512, 512, |x, y| image::Rgb([(x * 7) as u8, (y * 11) as u8, (x * y) as u8]));
    let mut encoded = Cursor::new(Vec::new());
    DynamicImage::ImageRgb8(pixels).write_to(&mut encoded, image::ImageFormat::Png).unwrap();
    let uri = format!("data:image/png;base64,{}", DATA_URL_BASE64.encode(encoded.into_inner()));
    let mut body = json!({"messages":[{"role":"user","content":[
        {"type":"text","text":"keep"}, {"type":"image_url","image_url":{"url":uri,"detail":"high"}},
        {"type":"image_url","image_url":"data:image/png;base64,broken"},
        {"type":"image_url","image_url":uri}, {"type":"image_url","image_url":"https://example.invalid/image.png"}
    ]}, {"role":"user","content":[{"type":"input_image","image_url":uri}]}]});
    let settings = ImageCompressSettings { enabled:true, max_edge:256, quality:60, threshold_kb:0 };
    let stats = compress_images_in_place(&mut body, &settings);
    assert_eq!(stats.compressed, 3);
    assert_eq!(stats.bytes_before, uri.len() * 3);
    let first = body["messages"][0]["content"][1]["image_url"]["url"].as_str().unwrap();
    assert!(first.starts_with("data:image/jpeg;base64,"));
    assert_eq!(stats.bytes_after, first.len() * 3);
    assert!(stats.bytes_after < stats.bytes_before);
    let decoded = DATA_URL_BASE64.decode(first.split_once(',').unwrap().1).unwrap();
    let image = image::load_from_memory(&decoded).unwrap();
    assert_eq!((image.width(), image.height()), (256, 256));
    assert_eq!(body["messages"][0]["content"][3]["image_url"], first);
    assert_eq!(body["messages"][1]["content"][0]["image_url"], first);
    assert_eq!(body["messages"][0]["content"][0]["text"], "keep");
    assert_eq!(body["messages"][0]["content"][1]["image_url"]["detail"], "high");
    assert_eq!(body["messages"][0]["content"][2]["image_url"], "data:image/png;base64,broken");
    assert_eq!(body["messages"][0]["content"][4]["image_url"], "https://example.invalid/image.png");
}
