import Foundation
import ImageIO
import Vision

do {
    let bytes = FileHandle.standardInput.readDataToEndOfFile()
    guard let source = CGImageSourceCreateWithData(bytes as CFData, nil),
          let info = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
          let width = info[kCGImagePropertyPixelWidth] as? Int,
          let height = info[kCGImagePropertyPixelHeight] as? Int,
          width > 0, height > 0, width <= 12000, height <= 12000, width * height <= 24_000_000 else {
        exit(2)
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = false
    try VNImageRequestHandler(data: bytes).perform([request])
    let lines = (request.results ?? []).prefix(300).compactMap { observation -> String? in
        guard let top = observation.topCandidates(1).first, top.confidence >= 0.25 else { return nil }
        return top.string
    }
    FileHandle.standardOutput.write(try JSONEncoder().encode(lines))
} catch {
    exit(2)
}
