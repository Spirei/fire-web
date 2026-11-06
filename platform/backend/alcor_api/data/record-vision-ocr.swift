import Foundation
import Vision
import ImageIO

// 用法: vision-ocr <图片路径>
// 输出: JSON 数组，每项为识别文本 + 归一化边界框（Vision 坐标系，原点在左下）
//   [{"text": "...", "x": 0.1, "y": 0.2, "w": 0.5, "h": 0.03}]

func fail(_ message: String) -> Never {
    FileHandle.standardError.write((message + "\n").data(using: .utf8)!)
    exit(1)
}

guard CommandLine.arguments.count >= 2 else {
    fail("用法: vision-ocr <图片路径>")
}

let path = CommandLine.arguments[1]
guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)) else {
    fail("无法读取文件: \(path)")
}
guard let source = CGImageSourceCreateWithData(data as CFData, nil),
      let cgImage = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
    fail("无法解码图片: \(path)")
}

// 读取 EXIF 方向，避免截图方向导致识别错乱
let orientationRaw = (CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])?[kCGImagePropertyOrientation] as? UInt32 ?? 1
let orientation = CGImagePropertyOrientation(rawValue: orientationRaw) ?? .up

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false
request.recognitionLanguages = ["zh-Hans", "en-US"]

let handler = VNImageRequestHandler(cgImage: cgImage, orientation: orientation, options: [:])
do {
    try handler.perform([request])
} catch {
    fail("识别失败: \(error)")
}

guard let observations = request.results as? [VNRecognizedTextObservation] else {
    fail("无识别结果")
}

var items: [[String: Any]] = []
for obs in observations {
    guard let candidate = obs.topCandidates(1).first else { continue }
    let text = candidate.string
        .replacingOccurrences(of: "\n", with: " ")
        .replacingOccurrences(of: "\t", with: " ")
        .trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { continue }
    let bb = obs.boundingBox
    items.append([
        "text": text,
        "x": bb.origin.x,
        "y": bb.origin.y,
        "w": bb.size.width,
        "h": bb.size.height
    ])
}

let output: Data
do {
    output = try JSONSerialization.data(withJSONObject: items, options: [])
} catch {
    fail("输出序列化失败: \(error)")
}
FileHandle.standardOutput.write(output)
