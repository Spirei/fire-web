import Foundation

private struct AlcorBrokerStatementFailure: Decodable { let code: Int; let message: String? }
struct AlcorBrokerStatementRejected: LocalizedError {
    var errorDescription: String? { "本次操作未执行，请核对配置或重新预览后再确认。" }
}

extension AlcorBrokerAccountsAPI {
    func recordSnapshot() async throws -> AlcorBrokerRecordSnapshot {
        try context.validate()
        var records: [StockRecord] = [], revision: Int?, total: Int?, page = 1
        while true {
            let query = revision.map { "&collectionRevision=\($0)" } ?? ""
            let request = try await authenticated(path: "records?page=\(page)&pageSize=100" + query)
            let (bytes, response) = try await transport.data(for: request, maximumBytes: 2 * 1024 * 1024)
            try context.validate(); try Task.checkCancellation()
            let result: ApiEnvelope<[StockRecord]> = try decodeEnvelope(bytes, response: response)
            guard let meta = result.meta, let count = meta.total, count >= 0, count <= 100_000,
                  meta.page == page, meta.pageSize == 100, let current = meta.collectionRevision, current >= 0,
                  let batch = result.data, batch.count <= 100 else { throw AlcorBrokerAccount.invalid() }
            if page == 1 { revision = current; total = count }
            guard revision == current, total == count else { throw ApiError(code: 40902, message: "持仓已变化，请重新读取") }
            records += batch
            guard records.count <= count, records.allSatisfy({ $0.id != nil }), Set(records.compactMap(\.id)).count == records.count else { throw AlcorBrokerAccount.invalid() }
            if records.count == count { return .init(records: records, revision: current) }
            guard !batch.isEmpty, page < 1000 else { throw AlcorBrokerAccount.invalid() }; page += 1
        }
    }
    func bind(_ ids: [String], to account: AlcorBrokerAccount, snapshot: AlcorBrokerRecordSnapshot,
              allowReassign: Bool, pending: AlcorBrokerAccountPending) async throws -> AlcorBrokerAccountOperation {
        guard contract.binding_path != nil, account.holdingSource != .official,
              contract.holding_source == nil || account.holdingSource == .manual, !ids.isEmpty, ids.count <= 2000, Set(ids).count == ids.count,
              ids.allSatisfy({ id in snapshot.records.contains { $0.id == id } }) else { throw AlcorBrokerAccount.invalid() }
        struct Input: Encodable { let requestId: String; let revision, recordCollectionRevision: Int; let recordIds: [String]; let allowReassign: Bool }
        return try await mutate("/" + account.id + "/bindings", method: "POST", body: Input(requestId: pending.requestId,
            revision: account.revision, recordCollectionRevision: snapshot.revision, recordIds: ids, allowReassign: allowReassign), pending: pending)
    }
    func unbind(_ ids: [String], from account: AlcorBrokerAccount, snapshot: AlcorBrokerRecordSnapshot,
                pending: AlcorBrokerAccountPending) async throws -> AlcorBrokerAccountOperation {
        guard contract.unbinding_path != nil, account.holdingSource != .official,
              contract.holding_source == nil || account.holdingSource == .manual,
              !ids.isEmpty, ids.count <= 2000, Set(ids).count == ids.count,
              ids.allSatisfy({ id in snapshot.records.contains { $0.id == id && $0.brokerAccountId == account.id } }) else {
            throw AlcorBrokerAccount.invalid()
        }
        struct Input: Encodable { let requestId: String; let revision, recordCollectionRevision: Int; let recordIds: [String] }
        return try await mutate("/" + account.id + "/unbindings", method: "POST", body: Input(requestId: pending.requestId,
            revision: account.revision, recordCollectionRevision: snapshot.revision, recordIds: ids), pending: pending)
    }
    func statementStatus(_ account: AlcorBrokerAccount) async throws -> AlcorBrokerStatementStatus {
        let result: AlcorBrokerStatementStatus = try await statementRead(account, suffix: "/connection")
        guard result.configured == (result.connectorId != nil), result.connectorId == nil || contract.statements?.connectors.contains(where: { $0.id == result.connectorId }) == true,
              result.latest.map({ AlcorBrokerStatementPreview.validDate($0.toDate) && AlcorFeedPresentation.date($0.importedAt) != nil && $0.cash.allSatisfy { $0.endingCash.isFinite } }) != false else { throw AlcorBrokerAccount.invalid() }
        return result
    }
    func configure(_ values: [String: String], connector: AlcorBrokerConnector, account: AlcorBrokerAccount,
                   pending: AlcorBrokerAccountPending) async throws -> AlcorBrokerAccountOperation {
        try requireConnector(connector, account: account)
        guard Set(values.keys) == Set(connector.fields.map(\.key)), values.values.allSatisfy({ !$0.isEmpty && $0.utf8.count <= 1024 }) else { throw ApiError(code: 40001, message: "请填写完整的读取配置") }
        var body: [String: Any] = values
        body["requestId"] = pending.requestId; body["revision"] = account.revision; body["connectorId"] = connector.id
        return try await statementMutation(account, suffix: "/connection", method: "PUT", body: body, pending: pending)
    }
    func disconnect(_ account: AlcorBrokerAccount, pending: AlcorBrokerAccountPending) async throws -> AlcorBrokerAccountOperation {
        try await statementMutation(account, suffix: "/connection", method: "DELETE",
            body: ["requestId": pending.requestId, "revision": account.revision], pending: pending)
    }
    func fetchStatement(_ account: AlcorBrokerAccount) async throws -> AlcorBrokerStatementPreview {
        let result: AlcorBrokerStatementPreview = try await statementRead(account, suffix: "/statements/fetch", method: "POST")
        try result.validate(account: account); return result
    }
    func previewStatement(_ data: Data, connector: AlcorBrokerConnector, externalAccount: String,
                          account: AlcorBrokerAccount) async throws -> AlcorBrokerStatementPreview {
        try requireConnector(connector, account: account)
        guard !data.isEmpty, data.count <= connector.maxBytes, externalAccount.range(of: "^[A-Za-z0-9-]{2,40}$", options: .regularExpression) != nil else { throw ApiError(code: 40001, message: "请选择有效账单并填写官方账户编号") }
        let boundary = "Alcor-" + UUID().uuidString
        var bytes = Data()
        for (key, value) in [("connectorId", connector.id), ("externalAccount", externalAccount)] {
            bytes.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(key)\"\r\n\r\n\(value)\r\n".utf8))
        }
        let mime = connector.accept.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
            .first { $0.range(of: "^[a-z0-9.+-]+/[a-z0-9.+-]+$", options: .regularExpression) != nil } ?? "application/octet-stream"
        bytes.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"statement\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
        bytes.append(data); bytes.append(Data("\r\n--\(boundary)--\r\n".utf8))
        var request = try await statementRequest(account, suffix: "/statements/preview", method: "POST")
        request.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type"); request.httpBody = bytes
        let result: AlcorBrokerStatementPreview = try await statementResponse(request)
        try result.validate(account: account); return result
    }
    func applyStatement(_ preview: AlcorBrokerStatementPreview, account: AlcorBrokerAccount, separate: Bool, takeOverOfficial: Bool = false,
                        pending: AlcorBrokerAccountPending) async throws -> AlcorBrokerAccountOperation {
        try preview.validate(account: account)
        guard let id = preview.previewId, preview.pending != true, preview.alreadyImported != true,
              preview.requiresUnassignedAcknowledgement != true || separate else { throw AlcorBrokerAccount.invalid() }
        if contract.holding_source != nil {
            guard let source = account.holdingSource, preview.holdingSource == source,
                  source != .manual || takeOverOfficial else { throw AlcorBrokerAccount.invalid() }
        } else if takeOverOfficial { throw AlcorBrokerAccount.invalid() }
        var body: [String: Any] = ["requestId": pending.requestId, "revision": account.revision,
            "previewId": id, "acknowledgeUnassigned": separate]
        if contract.holding_source != nil { body["takeOverOfficial"] = takeOverOfficial }
        let result = try await statementMutation(account, suffix: "/statements/apply", method: "POST", body: body, pending: pending)
        if contract.holding_source != nil {
            guard result.outcome?.holdingSource == .official, let revision = result.outcome?.accountRevision,
                  revision > account.revision else { throw AlcorBrokerAccount.invalid() }
        }
        return result
    }
    func useManual(_ account: AlcorBrokerAccount, snapshot: AlcorBrokerRecordSnapshot,
                   pending: AlcorBrokerAccountPending) async throws -> AlcorBrokerAccountOperation {
        guard contract.holding_source != nil, account.holdingSource == .official else { throw AlcorBrokerAccount.invalid() }
        struct Input: Encodable { let requestId: String; let revision, recordCollectionRevision: Int; let source: String }
        return try await mutate("/\(account.id)/holding-source", method: "PUT",
            body: Input(requestId: pending.requestId, revision: account.revision, recordCollectionRevision: snapshot.revision, source: "manual"), pending: pending)
    }
    private func requireConnector(_ connector: AlcorBrokerConnector, account: AlcorBrokerAccount) throws {
        guard connector.supports(account), contract.statements?.connectors.contains(connector) == true else { throw AlcorBrokerAccount.invalid() }
    }
    private func statementMutation(_ account: AlcorBrokerAccount, suffix: String, method: String, body: [String: Any],
                                   pending: AlcorBrokerAccountPending) async throws -> AlcorBrokerAccountOperation {
        var request = try await statementRequest(account, suffix: suffix, method: method)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let result: AlcorBrokerAccountOperation = try await statementResponse(request)
        try result.validate(pending, context: context); return result
    }
    private func statementRead<T: Decodable>(_ account: AlcorBrokerAccount, suffix: String, method: String = "GET") async throws -> T {
        let request = try await statementRequest(account, suffix: suffix, method: method)
        return try await statementResponse(request)
    }
    private func statementRequest(_ account: AlcorBrokerAccount, suffix: String, method: String) async throws -> URLRequest {
        try context.validate(write: method != "GET"); try account.validate(version: context.version, origin: context.origin)
        guard contract.statements != nil else { throw ApiError(code: 40301, message: "当前服务尚未开放官方账单") }
        var request = try await authenticated(path: "broker-accounts/" + account.id + suffix)
        request.httpMethod = method; request.timeoutInterval = method == "GET" ? 8 : 30; return request
    }
    private func statementResponse<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (bytes, response) = try await transport.data(for: request, maximumBytes: 16 * 1024 * 1024)
        try context.validate(write: request.httpMethod != "GET"); try Task.checkCancellation()
        let result: ApiEnvelope<T> = try decodeEnvelope(bytes, response: response)
        guard let value = result.data else { throw AlcorBrokerAccount.invalid() }; return value
    }
    private func decodeEnvelope<T: Decodable>(_ bytes: Data, response: URLResponse) throws -> ApiEnvelope<T> {
        guard let http = response as? HTTPURLResponse else { throw AlcorBrokerAccount.invalid() }
        guard (200...299).contains(http.statusCode) else {
            // A definite validation/auth/size rejection is not an unknown commit.
            // 409 may mean duplicate UUID; keep it behind the original receipt gate.
            if [400, 401, 403, 404, 413, 422, 429].contains(http.statusCode) { throw AlcorBrokerStatementRejected() }
            let failure = try? JSONDecoder().decode(AlcorBrokerStatementFailure.self, from: bytes)
            throw ApiError(code: failure?.code ?? http.statusCode, message: "账单或账户操作未完成，请刷新后核对")
        }
        let result = try JSONDecoder().decode(ApiEnvelope<T>.self, from: bytes)
        guard result.code == 0 else { throw ApiError(code: result.code, message: "账单或账户操作未完成，请刷新后核对") }
        return result
    }
}
