// The words in a photo (a receipt, a sign, a page), read on the device by Apple's text
// recognition, so the photo can be found by them in the DO Notes search (src/fileText.ts). Nothing is
// sent anywhere to read it.

import CoreGraphics
import Foundation
import ImageIO
import Vision

enum TextReader {
    /// The photo's words, line by line; "" when there are none or it can't be read.
    static func words(in data: Data) async -> String {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, [kCGImageSourceShouldAllowFloat: false] as CFDictionary)
        else { return "" }
        return await withCheckedContinuation { done in
            let request = VNRecognizeTextRequest { req, _ in
                let lines = (req.results as? [VNRecognizedTextObservation] ?? []).compactMap { $0.topCandidates(1).first?.string }
                done.resume(returning: lines.joined(separator: "\n"))
            }
            request.recognitionLevel = .accurate
            request.usesLanguageCorrection = true
            do {
                try VNImageRequestHandler(cgImage: image, options: [:]).perform([request])
            } catch {
                done.resume(returning: "")
            }
        }
    }
}
