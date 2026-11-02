// Sending what was shared to POST /api/capture (src/capture.ts): the same form the Shortcut sends
// (docs/IPHONE-SHORTCUT.md), so the server treats both alike. `item` is a shared text or link,
// `url` a link, `title` the page's title, and `photo` each picture. Photos win on the server:
// with a photo, any text is just its name.

import Foundation

enum Shared: Equatable {
    case link(URL, title: String?)
    case text(String)
    case photo(Data, filename: String, mimeType: String)
    /// A file with its words read on the device: a photo's text, a voice note's transcript.
    case file(Data, filename: String, mimeType: String, words: String)
}

/// The server's own limit (src/capture.ts MAX_ITEMS).
let maxCaptureItems = 10

struct CaptureForm {
    let boundary: String
    let body: Data

    var contentType: String { "multipart/form-data; boundary=\(boundary)" }

    init(_ items: [Shared], boundary: String = "cp-" + UUID().uuidString) {
        self.boundary = boundary
        var b = Data()
        func field(_ name: String, _ value: String) {
            b.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n")
        }
        func file(_ name: String, _ data: Data, _ filename: String, _ type: String) {
            let safe = filename.replacingOccurrences(of: "\"", with: "").replacingOccurrences(of: "\r", with: "").replacingOccurrences(of: "\n", with: "")
            b.append("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"; filename=\"\(safe)\"\r\nContent-Type: \(type)\r\n\r\n")
            b.append(data)
            b.append("\r\n")
        }
        var titled = false
        for item in items.prefix(maxCaptureItems) {
            switch item {
            case let .link(url, title):
                field("item", url.absoluteString)
                field("url", url.absoluteString)
                if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty, !titled {
                    field("title", t)
                    titled = true
                }
            case let .text(s):
                field("item", s)
            case let .photo(data, filename, type):
                file("photo", data, filename, type)
                field("file_text", "") // one per file, in order (src/capture.ts)
            case let .file(data, filename, type, words):
                file("photo", data, filename, type)
                field("file_text", words)
            }
        }
        b.append("--\(boundary)--\r\n")
        body = b
    }
}

enum CaptureResult: Equatable {
    /// The server's words, such as "Saved it to Inbox".
    case saved(String)
    /// No token, or the server refused it (revoked, or no longer an editor).
    case signedOut
    case failed(String)
}

struct CaptureClient {
    var server: URL = AppConfig.serverURL
    var session: URLSession = .shared

    func send(_ items: [Shared], token: CaptureToken?) async -> CaptureResult {
        guard let token else { return .signedOut }
        let form = CaptureForm(items)
        var req = URLRequest(url: server.appendingPathComponent("api/capture"))
        req.httpMethod = "POST"
        req.timeoutInterval = 90
        req.setValue("Bearer \(token.token)", forHTTPHeaderField: "Authorization")
        req.setValue(form.contentType, forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        do {
            let (data, response) = try await session.upload(for: req, from: form.body)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            if (200..<300).contains(status) { return .saved(json?["message"] as? String ?? "Saved") }
            if status == 401 || status == 403 { return .signedOut }
            return .failed(json?["error"] as? String ?? "DO Notes couldn't save it (error \(status)).")
        } catch {
            return .failed("Couldn't reach DO Notes, so nothing was saved. Check you're online and try again.")
        }
    }
}

extension Data {
    mutating func append(_ s: String) { append(Data(s.utf8)) }
}
