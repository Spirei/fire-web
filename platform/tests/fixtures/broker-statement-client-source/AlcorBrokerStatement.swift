import Foundation

struct AlcorBrokerStatementContract: Decodable, Equatable {
    let connectors: [AlcorBrokerConnector]
    let connection_path, preview_path, fetch_path, apply_path: String
    let max_bytes: Int
    let preview_required, automatic_apply: Bool
    func validate(base: String) throws {
        guard connection_path == base + "/{accountId}/connection",
              preview_path == base + "/{accountId}/statements/preview",
              fetch_path == base + "/{accountId}/statements/fetch",
              apply_path == base + "/{accountId}/statements/apply",
              max_bytes > 0, max_bytes <= 8_388_608, preview_required, !automatic_apply,
              connectors.count <= 30, Set(connectors.map(\.id)).count == connectors.count else { throw AlcorBrokerAccount.invalid() }
        for connector in connectors { try connector.validate(maximum: max_bytes) }
    }
}

struct AlcorBrokerConnector: Decodable, Equatable, Identifiable {
    struct Field: Decodable, Equatable, Identifiable {
        let key, label: String
        let secret: Bool
        var id: String { key }
    }
    let id, providerId, label, helpUrl, accept, fileLabel, externalAccountLabel: String
    let maxBytes: Int
    let fields: [Field]
    func supports(_ account: AlcorBrokerAccount) -> Bool {
        guard let provider = account.providerId else { return false }
        return providerId == provider
    }
    func validate(maximum: Int) throws {
        guard id.range(of: "^[a-z0-9-]{1,60}$", options: .regularExpression) != nil,
              providerId.range(of: "^[a-z0-9-]{1,60}$", options: .regularExpression) != nil,
              !label.isEmpty, label.count <= 100, fields.count <= 12, !fields.isEmpty,
              Set(fields.map(\.key)).count == fields.count, maxBytes > 0, maxBytes <= maximum,
              fields.allSatisfy({ $0.key.range(of: "^[A-Za-z][A-Za-z0-9]{0,39}$", options: .regularExpression) != nil && !$0.label.isEmpty && $0.label.count <= 100 }),
              let help = URL(string: helpUrl), help.scheme == "https", help.host != nil, help.user == nil, help.password == nil else { throw AlcorBrokerAccount.invalid() }
    }
}

struct AlcorBrokerStatementStatus: Decodable {
    struct Cash: Decodable { let currency: String; let endingCash: Double }
    struct Latest: Decodable { let toDate, importedAt: String; let cash: [Cash] }
    let configured: Bool
    let holdingSource: AlcorBrokerHoldingSource?
    let connectorId: String?
    let latest: Latest?
}

/// Preserve a server's real numerical value; never substitute a missing value with zero.
struct AlcorBrokerStatementNumber: Decodable {
    let value: Double?
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if let number = try? c.decode(Double.self) { value = number }
        else {
            let text = try c.decode(String.self)
            guard text.isEmpty || Double(text) != nil else { throw AlcorBrokerAccount.invalid() }
            value = Double(text)
        }
        guard value?.isFinite != false else { throw AlcorBrokerAccount.invalid() }
    }
    var text: String { value?.formatted(.number.precision(.fractionLength(0...16))) ?? "—" }
}

struct AlcorBrokerStatementPreview: Decodable {
    struct Before: Decodable { let qty, cost, price: AlcorBrokerStatementNumber }
    struct Row: Decodable, Identifiable {
        let key, conid, code, name, market, currency, action: String
        let qty, cost, price: AlcorBrokerStatementNumber
        let recordId: String?
        let before: Before?
        let unassignedMatches: [String]
        var id: String { key }
    }
    struct Missing: Decodable, Identifiable {
        let recordId, code, market: String
        let before, after: AlcorBrokerStatementNumber
        var id: String { recordId }
    }
    let pending: Bool?
    let retryAfterSeconds: Int?
    let alreadyImported: Bool?
    let previewId, digest, toDate, fromDate: String?
    let accountRevision, collectionRevision, eventCount: Int?
    let rows: [Row]?
    let missing: [Missing]?
    let cash: [AlcorBrokerStatementStatus.Cash]?
    let warnings: [String]?
    let requiresUnassignedAcknowledgement: Bool?
    let holdingSource: AlcorBrokerHoldingSource?
    let requiresOfficialTakeover: Bool?
    func validate(account: AlcorBrokerAccount) throws {
        if pending == true {
            guard let retryAfterSeconds, (1...300).contains(retryAfterSeconds), previewId == nil else { throw AlcorBrokerAccount.invalid() }; return
        }
        guard let digest, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil else { throw AlcorBrokerAccount.invalid() }
        if alreadyImported == true { guard previewId == nil else { throw AlcorBrokerAccount.invalid() }; return }
        if let source = account.holdingSource {
            guard holdingSource == source, requiresOfficialTakeover == (source == .manual) else { throw AlcorBrokerAccount.invalid() }
        } else if holdingSource != nil || requiresOfficialTakeover != nil { throw AlcorBrokerAccount.invalid() }
        guard let previewId, previewId.range(of: "^bsp-[a-f0-9]{32}$", options: .regularExpression) != nil,
              accountRevision == account.revision, let collectionRevision, collectionRevision >= 0,
              let toDate, Self.validDate(toDate), let fromDate, Self.validDate(fromDate), fromDate <= toDate,
              let rows, rows.count <= 10_000, Set(rows.map(\.id)).count == rows.count,
              let missing, missing.count <= 10_000, Set(missing.map(\.id)).count == missing.count,
              let cash, cash.count <= 100, cash.allSatisfy({ $0.endingCash.isFinite && $0.currency.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil }),
              let eventCount, eventCount >= 0, let warnings, warnings.count <= 1000,
              requiresUnassignedAcknowledgement == rows.contains(where: { !$0.unassignedMatches.isEmpty }),
              rows.allSatisfy({ ["US", "HK", "CN"].contains($0.market) && $0.currency.range(of: "^[A-Z]{3}$", options: .regularExpression) != nil &&
                  ["create", "update"].contains($0.action) && ($0.qty.value ?? -1) >= 0 && $0.price.value != nil && $0.cost.value != nil && !$0.code.isEmpty &&
                  ($0.action == "create" ? $0.recordId == nil && $0.before == nil : $0.recordId != nil && $0.before != nil) }),
              missing.allSatisfy({ $0.after.value == 0 }) else { throw AlcorBrokerAccount.invalid() }
    }
    static func validDate(_ value: String) -> Bool {
        guard value.range(of: "^[0-9]{8}$", options: .regularExpression) != nil else { return false }
        let f = DateFormatter(); f.locale = Locale(identifier: "en_US_POSIX"); f.dateFormat = "yyyyMMdd"; f.isLenient = false
        guard let date = f.date(from: value) else { return false }; return f.string(from: date) == value
    }
}

struct AlcorBrokerStatementOutcome: Decodable {
    let configured: Bool?
    let holdingSource: AlcorBrokerHoldingSource?
    let accountRevision: Int?
    let digest: String?
    let updated, created, closed, eventCount, collectionRevision: Int?
    func validate(kind: String) throws {
        switch kind {
        case "configure_statement": guard configured == true else { throw AlcorBrokerAccount.invalid() }
        case "disconnect_statement": guard configured == false else { throw AlcorBrokerAccount.invalid() }
        case "set_holding_source":
            guard holdingSource == .manual, let accountRevision, accountRevision > 0, let collectionRevision, collectionRevision >= 0 else { throw AlcorBrokerAccount.invalid() }
        case "import_statement":
            if holdingSource != nil || accountRevision != nil {
                guard holdingSource == .official, let accountRevision, accountRevision > 0 else { throw AlcorBrokerAccount.invalid() }
            }
            guard let digest, digest.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil,
                  [updated, created, closed, eventCount, collectionRevision].allSatisfy({ ($0 ?? -1) >= 0 }) else { throw AlcorBrokerAccount.invalid() }
        default: throw AlcorBrokerAccount.invalid()
        }
    }
}

struct AlcorBrokerRecordSnapshot {
    let records: [StockRecord]
    let revision: Int
}


enum AlcorBrokerHoldingSource: String, Codable {
    case manual, official
    var title: String { self == .manual ? "手动" : "官方" }
}
struct AlcorBrokerHoldingSourceContract: Decodable, Equatable {
    let version: Int
    let field, manual_path, takeover_field, default_source: String
    let offline_fallback: Bool
    func validate(base: String) throws {
        guard version == 1, field == "holdingSource", manual_path == base + "/{accountId}/holding-source",
              takeover_field == "takeOverOfficial", default_source == "manual", !offline_fallback else { throw AlcorBrokerAccount.invalid() }
    }
}
