// Prints calendar events as JSON lines.
// Usage: lotus-cal <offsetDays> <numDays>   e.g. `lotus-cal 0 3` = today through end of the day after tomorrow
import EventKit
import Foundation

let args = CommandLine.arguments
guard args.count == 3, let offset = Int(args[1]), let days = Int(args[2]) else {
    FileHandle.standardError.write("usage: lotus-cal <offsetDays> <numDays>\n".data(using: .utf8)!)
    exit(2)
}

let cal = Calendar.current
let start = cal.date(byAdding: .day, value: offset, to: cal.startOfDay(for: Date()))!
let end = cal.date(byAdding: .day, value: days, to: start)!

let store = EKEventStore()
let sem = DispatchSemaphore(value: 0)
var granted = false
store.requestFullAccessToEvents { ok, _ in granted = ok; sem.signal() }
sem.wait()
guard granted else {
    FileHandle.standardError.write("calendar access denied\n".data(using: .utf8)!)
    exit(1)
}

let iso = ISO8601DateFormatter()
let events = store.events(matching: store.predicateForEvents(withStart: start, end: end, calendars: nil))
    .sorted { $0.startDate < $1.startDate }
for e in events {
    let row: [String: Any] = [
        "title": e.title ?? "(no title)",
        "start": iso.string(from: e.startDate),
        "end": iso.string(from: e.endDate),
        "allDay": e.isAllDay,
        "calendar": e.calendar.title,
    ]
    let data = try! JSONSerialization.data(withJSONObject: row)
    print(String(data: data, encoding: .utf8)!)
}
