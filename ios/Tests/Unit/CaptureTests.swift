import XCTest
@testable import Commonplace

final class CaptureTests: XCTestCase {
    private func text(_ form: CaptureForm) -> String { String(decoding: form.body, as: UTF8.self) }

    func testALinkIsSentAsTheShortcutSendsIt() {
        let form = CaptureForm([.link(URL(string: "https://example.com/tiling")!, title: "How to tile")], boundary: "B")
        let s = text(form)
        XCTAssertEqual(form.contentType, "multipart/form-data; boundary=B")
        XCTAssertTrue(s.contains("name=\"item\"\r\n\r\nhttps://example.com/tiling\r\n"))
        XCTAssertTrue(s.contains("name=\"url\"\r\n\r\nhttps://example.com/tiling\r\n"))
        XCTAssertTrue(s.contains("name=\"title\"\r\n\r\nHow to tile\r\n"))
        XCTAssertTrue(s.hasSuffix("--B--\r\n"))
    }

    func testTextAndPhotos() {
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0x00])
        let form = CaptureForm([.text("Ring the electrician\nabout the hob"), .photo(jpeg, filename: "IMG \"1\".heic", mimeType: "image/heic")], boundary: "B")
        let s = String(decoding: form.body, as: UTF8.self)
        XCTAssertTrue(s.contains("name=\"item\"\r\n\r\nRing the electrician\nabout the hob\r\n"))
        // A quote in a file name can't break out of the header.
        XCTAssertTrue(s.contains("name=\"photo\"; filename=\"IMG 1.heic\"\r\nContent-Type: image/heic\r\n\r\n"))
        XCTAssertNotNil(form.body.range(of: jpeg))
    }

    func testEachFileGoesWithItsWordsInOrder() {
        let audio = Data([0x00, 0x00, 0x00, 0x18])
        let form = CaptureForm([.photo(Data([0xFF]), filename: "a.jpg", mimeType: "image/jpeg"), .file(audio, filename: "Voice note.m4a", mimeType: "audio/mp4", words: "Ring the plumber")], boundary: "B")
        let s = String(decoding: form.body, as: UTF8.self)
        // The photo's (none read) comes before the voice note's, so the server pairs them by order.
        let empty = s.range(of: "name=\"file_text\"\r\n\r\n\r\n")!
        let heard = s.range(of: "name=\"file_text\"\r\n\r\nRing the plumber\r\n")!
        XCTAssertLessThan(empty.lowerBound, heard.lowerBound)
        XCTAssertTrue(s.contains("filename=\"Voice note.m4a\"\r\nContent-Type: audio/mp4"))
    }

    func testNoMoreThanTheServerTakes() {
        let many = (1...15).map { Shared.text("item \($0)") }
        let s = text(CaptureForm(many, boundary: "B"))
        XCTAssertEqual(s.components(separatedBy: "name=\"item\"").count - 1, maxCaptureItems)
    }

    func testWithoutATokenNothingIsSent() async {
        let r = await CaptureClient(server: URL(string: "http://127.0.0.1:9")!).send([.text("x")], token: nil)
        XCTAssertEqual(r, .signedOut)
    }

    func testTheServerAnswer() async throws {
        StubProtocol.reply = (200, #"{"ok":true,"message":"Saved it to Inbox"}"#)
        let r = await client().send([.text("x")], token: CaptureToken(id: 1, token: "cpc_abc"))
        XCTAssertEqual(r, .saved("Saved it to Inbox"))
        let req = try XCTUnwrap(StubProtocol.last)
        XCTAssertEqual(req.url?.path, "/api/capture")
        XCTAssertEqual(req.value(forHTTPHeaderField: "Authorization"), "Bearer cpc_abc")
        XCTAssertNil(req.url?.query, "the token never goes in the address")

        StubProtocol.reply = (401, #"{"error":"That token isn't valid"}"#)
        let refused = await client().send([.text("x")], token: CaptureToken(id: 1, token: "cpc_old"))
        XCTAssertEqual(refused, .signedOut)

        StubProtocol.reply = (404, #"{"error":"There's no home collection to save to"}"#)
        let failed = await client().send([.text("x")], token: CaptureToken(id: 1, token: "cpc_abc"))
        XCTAssertEqual(failed, .failed("There's no home collection to save to"))
    }

    func testTheOriginIsTheServers() {
        XCTAssertEqual(AppConfig.origin(of: URL(string: "http://localhost:8070/x")!), "http://localhost:8070")
        XCTAssertEqual(AppConfig.origin(of: URL(string: "https://notes.example.com")!), "https://notes.example.com")
    }

    func testTheTokenIsKept() {
        // The app group's keychain, as the app and the extension use it.
        let store = TokenStore(service: "commonplace.test", account: "test-\(UUID())", accessGroup: AppConfig.keychainGroup)
        XCTAssertNil(store.read())
        store.write(CaptureToken(id: 7, token: "cpc_one"))
        store.write(CaptureToken(id: 8, token: "cpc_two"))
        XCTAssertEqual(store.read(), CaptureToken(id: 8, token: "cpc_two"))
        store.clear()
        XCTAssertNil(store.read())
    }

    private func client() -> CaptureClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        return CaptureClient(server: URL(string: "https://commonplace.test")!, session: URLSession(configuration: config))
    }
}

final class StubProtocol: URLProtocol {
    nonisolated(unsafe) static var reply: (Int, String) = (200, "{}")
    nonisolated(unsafe) static var last: URLRequest?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }
    override func startLoading() {
        Self.last = request
        let (status, body) = Self.reply
        let res = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: res, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }
    override func stopLoading() {}
}
