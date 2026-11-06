import Foundation

struct AlcorBrokerAccount: Codable, Identifiable, Hashable {
    let id, name: String
    let providerId: String?
    let currency: String
    let revision: Int
    let icon: String?
    let iconSource, recordGroup: String
    let recordCount: Int
    let createdAt, updatedAt: String
    var holdingSource: AlcorBrokerHoldingSource? = nil
    var preset: AlcorBrokerPreset? { AlcorBrokerPreset.bundled.first { $0.id == providerId } }
    var broker: Broker { .init(id: id, name: name, icon: icon, currency: currency, personalAccount: self) }
    func validate(version: AlcorAPIVersion, origin: URL) throws {
        guard Self.validID(id), Self.validName(name), recordGroup == name, revision > 0, recordCount >= 0,
              currency.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil,
              providerId == nil || providerId?.range(of: "^[a-z0-9-]{1,60}$", options: .regularExpression) != nil,
              ["custom", "preset", "none"].contains(iconSource),
              AlcorFeedPresentation.date(createdAt) != nil, AlcorFeedPresentation.date(updatedAt) != nil else { throw Self.invalid() }
        if iconSource == "custom" {
            guard icon == version.prefix + "/broker-accounts/" + id + "/icon" else { throw Self.invalid() }
        } else if let icon, !icon.isEmpty {
            guard let url = AlcorMediaPolicy.url(icon, origin: origin), url.scheme == origin.scheme,
                  url.host == origin.host, url.port == origin.port else { throw Self.invalid() }
        }
    }
    static func validID(_ value: String) -> Bool {
        value.range(of: "^ba-[A-Za-z0-9_-]{1,100}$", options: .regularExpression) != nil
    }
    static func validName(_ value: String) -> Bool {
        !value.isEmpty && value.count <= 60 && value == value.trimmingCharacters(in: .whitespacesAndNewlines)
            && value.unicodeScalars.allSatisfy { !CharacterSet.controlCharacters.contains($0) }
    }
    static func invalid() -> ApiError { .init(code: 50001, message: "券商账户返回无效结果") }
}

struct AlcorBrokerAccountsPage: Decodable {
    let accountId: String
    let items: [AlcorBrokerAccount]
    let collectionRevision: Int
}

