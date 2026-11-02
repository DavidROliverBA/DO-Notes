// Quick capture (F36): a few words straight into the Inbox, from the iPhone's widget
// (commonplace://capture), or the Mac's hotkey and menu-bar item. It sends what you type as the
// share extension sends text (Shared/ShareModel.swift), with the same token; or a voice note,
// recorded and transcribed on the device (Shared/VoiceNote.swift).

import SwiftUI

struct QuickCaptureView: View {
    @StateObject private var model = ShareModel()
    @StateObject private var voice = VoiceNote()
    @State private var text = ""
    @FocusState private var focused: Bool
    var close: () -> Void

    private var words: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Save to Inbox").font(.headline)
                Spacer()
                if model.phase == .sending { ProgressView().controlSize(.small).accessibilityLabel("Saving") }
            }
            switch model.phase {
            case .signedOut:
                Label("Open DO Notes and sign in, then try again.", systemImage: "person.crop.circle.badge.exclamationmark")
            case let .done(message):
                Label(message, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
            default:
                if voice.phase != .idle {
                    voiceBox
                } else {
                    typing
                }
                if case let .failed(message) = model.phase {
                    Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red).font(.callout)
                }
                Text("A to-do in the Inbox of your home collection, to file later.").font(.footnote).foregroundStyle(.secondary)
            }
            HStack {
                if model.phase != .signedOut, !isDone, voice.phase == .idle {
                    Button {
                        Task { await voice.start() }
                    } label: {
                        Label("Record", systemImage: "mic")
                    }
                    .accessibilityLabel("Record a voice note")
                }
                Spacer()
                Button(model.phase == .signedOut ? "Close" : "Cancel", role: .cancel) {
                    voice.discard()
                    close()
                }
                .keyboardShortcut(.cancelAction)
                if model.phase != .signedOut, !isDone {
                    Button("Save") {
                        if let item = voice.item() {
                            model.items = [item]
                        } else {
                            model.items = [.text(words)]
                        }
                        model.save()
                    }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave || model.phase == .sending)
                    .bold()
                }
            }
        }
        .padding(16)
        .onAppear {
            model.phase = .ready
            model.close = { voice.discard(); close() }
            model.cancel = close
            focused = true
        }
    }

    private var canSave: Bool {
        if case .ready = voice.phase { return true }
        return voice.phase == .idle && !words.isEmpty
    }

    private var typing: some View {
        TextEditor(text: $text)
            .focused($focused)
            .frame(minHeight: 90)
            .scrollContentBackground(.hidden)
            .padding(6)
            .background(RoundedRectangle(cornerRadius: 8).fill(.quaternary.opacity(0.5)))
            .accessibilityLabel("What to save")
    }

    @ViewBuilder private var voiceBox: some View {
        switch voice.phase {
        case let .recording(since):
            HStack {
                Image(systemName: "waveform").foregroundStyle(.red).accessibilityHidden(true)
                Text(since, style: .timer).monospacedDigit()
                Spacer()
                Button {
                    Task { await voice.stop() }
                } label: {
                    Label("Stop", systemImage: "stop.circle.fill")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityLabel("Recording")
        case .transcribing:
            ProgressView("Writing down what you said…")
        case let .ready(transcript):
            VStack(alignment: .leading, spacing: 6) {
                Label("Voice note", systemImage: "waveform")
                Text(transcript.isEmpty ? "No words were made out; the recording is kept." : transcript)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .lineLimit(6)
                Button("Record again", role: .destructive) { voice.discard() }
            }
        case let .refused(message):
            Label(message, systemImage: "mic.slash")
        case .idle:
            EmptyView()
        }
    }

    private var isDone: Bool {
        if case .done = model.phase { return true }
        return false
    }
}
