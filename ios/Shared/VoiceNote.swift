// Voice notes (Phase 2): record on the iPhone or Mac, transcribe on the device with Apple's speech
// recognition (on-device where the language allows, so the recording isn't sent to Apple), and
// send both to the Inbox: the recording kept as an attachment, the transcript quoted under it and
// searchable (src/capture.ts, src/fileText.ts).

import AVFoundation
import Combine
import Foundation
import Speech

@MainActor
final class VoiceNote: ObservableObject {
    enum Phase: Equatable {
        case idle
        case recording(since: Date)
        case transcribing
        case ready(transcript: String)
        case refused(String)
    }

    @Published var phase: Phase = .idle
    private var recorder: AVAudioRecorder?
    private(set) var file: URL?

    /// The recording, named for when it was made, as the server keeps it.
    var filename: String {
        let f = DateFormatter()
        f.dateFormat = "d MMM yyyy HH.mm"
        return "Voice note \(f.string(from: Date())).m4a"
    }

    func start() async {
        guard await Self.mayRecord() else {
            phase = .refused("DO Notes isn't allowed to use the microphone. Turn it on in Settings → Privacy & Security → Microphone.")
            return
        }
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setCategory(.record, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        #endif
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("voice-\(UUID().uuidString).m4a")
        let settings: [String: Any] = [AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 44_100, AVNumberOfChannelsKey: 1, AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue]
        do {
            recorder = try AVAudioRecorder(url: url, settings: settings)
            recorder?.record()
            file = url
            phase = .recording(since: Date())
        } catch {
            phase = .refused("Couldn't start recording.")
        }
    }

    func stop() async {
        recorder?.stop()
        recorder = nil
        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif
        guard let file else { phase = .idle; return }
        phase = .transcribing
        phase = .ready(transcript: await Self.transcribe(file))
    }

    func discard() {
        recorder?.stop()
        recorder = nil
        if let file { try? FileManager.default.removeItem(at: file) }
        file = nil
        phase = .idle
    }

    /// What to send: the recording and its transcript.
    func item() -> Shared? {
        guard case let .ready(transcript) = phase, let file, let data = try? Data(contentsOf: file) else { return nil }
        return .file(data, filename: filename, mimeType: "audio/mp4", words: transcript)
    }

    private static func mayRecord() async -> Bool {
        #if os(iOS)
        return await AVAudioApplication.requestRecordPermission()
        #else
        return await AVCaptureDevice.requestAccess(for: .audio)
        #endif
    }

    /// The words in a recording; "" when speech recognition isn't allowed or heard nothing.
    static func transcribe(_ url: URL) async -> String {
        let allowed = await withCheckedContinuation { done in SFSpeechRecognizer.requestAuthorization { done.resume(returning: $0 == .authorized) } }
        guard allowed, let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else { return "" }
        let request = SFSpeechURLRecognitionRequest(url: url)
        if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
        request.shouldReportPartialResults = false
        return await withCheckedContinuation { done in
            var finished = false
            recognizer.recognitionTask(with: request) { result, error in
                guard !finished else { return }
                if let result, result.isFinal {
                    finished = true
                    done.resume(returning: result.bestTranscription.formattedString)
                } else if error != nil {
                    finished = true
                    done.resume(returning: "")
                }
            }
        }
    }
}
