import Foundation

enum AlcorAPIVersion { case v1, v2; var prefix: String { self == .v1 ? "/api/v1" : "/api/v2" } }
enum AlcorBrokerHoldingSource: String, Codable { case manual, official }
struct AlcorBrokerPreset { let id: String; static let bundled: [Self] = [] }
struct Broker { init(id: String, name: String, icon: String?, currency: String, personalAccount: AlcorBrokerAccount) {} }
struct ApiError: Error { let code: Int; let message: String }
enum AlcorMediaPolicy { static func url(_ text: String, origin: URL) -> URL? { URL(string: text, relativeTo: origin)?.absoluteURL } }
enum AlcorFeedPresentation {
    static func date(_ text: String) -> Date? {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: text) { return d }
        f.formatOptions = [.withInternetDateTime]; return f.date(from: text)
    }
}
@main struct Main {
    static func main() throws {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        let page = try JSONDecoder().decode(AlcorBrokerAccountsPage.self, from: input)
        let version: AlcorAPIVersion = CommandLine.arguments.last == "1" ? .v1 : .v2
        for account in page.items { try account.validate(version: version, origin: URL(string: "https://synthetic.invalid")!) }
        let result: [String: Any] = ["owner": page.accountId, "ids": page.items.map(\.id), "revision": page.collectionRevision, "holdingSources": page.items.map { $0.holdingSource?.rawValue ?? "unknown" }]
        FileHandle.standardOutput.write(try JSONSerialization.data(withJSONObject: result))
    }
}
