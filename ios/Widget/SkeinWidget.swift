// The DO Notes widgets (F36): on the home screen and the lock screen, a tap opens the app's quick
// capture (commonplace://capture), which saves a few words to the Inbox.

import SwiftUI
import WidgetKit

struct Entry: TimelineEntry {
    let date: Date
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> Entry { Entry(date: .now) }
    func getSnapshot(in context: Context, completion: @escaping (Entry) -> Void) { completion(Entry(date: .now)) }
    func getTimeline(in context: Context, completion: @escaping (Timeline<Entry>) -> Void) {
        completion(Timeline(entries: [Entry(date: .now)], policy: .never))
    }
}

struct CaptureWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: Entry

    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack {
                AccessoryWidgetBackground()
                Image(systemName: "square.and.pencil").font(.title3)
            }
            .accessibilityLabel("Save to DO Notes")
        case .accessoryRectangular:
            VStack(alignment: .leading) {
                Text("DO Notes").font(.headline)
                Label("Save to Inbox", systemImage: "square.and.pencil")
            }
        case .accessoryInline:
            Label("Save to DO Notes", systemImage: "square.and.pencil")
        default:
            VStack(alignment: .leading, spacing: 6) {
                Image(systemName: "square.and.pencil")
                    .font(.title)
                    .foregroundStyle(Color(red: 0.96, green: 0.77, blue: 0.33))
                Spacer()
                Text("Save to Inbox").font(.headline).foregroundStyle(.white)
                Text("DO Notes").font(.caption).foregroundStyle(.white.opacity(0.75))
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        }
    }
}

@main
struct SkeinWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "capture", provider: Provider()) { entry in
            CaptureWidgetView(entry: entry)
                .widgetURL(URL(string: "commonplace://capture"))
                .containerBackground(for: .widget) {
                    LinearGradient(colors: [Color(red: 0.18, green: 0.33, blue: 0.59), Color(red: 0.07, green: 0.16, blue: 0.32)], startPoint: .top, endPoint: .bottom)
                }
        }
        .configurationDisplayName("Save to DO Notes")
        .description("Write a few words straight into your Inbox.")
        .supportedFamilies([.systemSmall, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
