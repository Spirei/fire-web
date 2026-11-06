import Foundation
@main struct Decode {
    struct Input: Decodable {
        let owner: String
        let before, after: AlcorAccountSyncRevision
        let snapshot: AlcorAccountStateSnapshot
        let mutation: AlcorAccountStateMutation
        let receipt: AlcorAccountStateReceipt
    }
    static func main() throws {
        let bytes = FileHandle.standardInput.readDataToEndOfFile()
        if CommandLine.arguments.last == "--discovery" {
            struct Configuration: Decodable { let account_sync: AlcorAccountSyncConfiguration? }
            let value = try JSONDecoder().decode(Configuration.self, from: bytes)
            print(value.account_sync?.usable == true ? "protocol_supported_not_connection_confirmed" : "discovery_unavailable_sync_disabled")
            return
        }
        if CommandLine.arguments.last == "--fees" {
            let value = try JSONDecoder().decode(AlcorAccountStateSnapshot.self, from: bytes)
            try value.validate(userID: value.userId, namespace: "fees")
            var markets = Set<AlcorPersonalFeeMarket>()
            for entry in value.fields.values {
                if entry.value == .null { continue }
                let plan = try entry.value.decoded(AlcorPersonalFeePlan.self)
                try plan.validate(); markets.insert(plan.market)
            }
            guard markets == Set(AlcorPersonalFeeMarket.allCases) else { throw AlcorAccountSyncFailure.invalid }
            print("five_fee_markets_decoded_exactly;no_financial_postings")
            return
        }
        let input = try JSONDecoder().decode(Input.self, from: bytes)
        try input.before.validate(userID: input.owner)
        try input.after.validate(userID: input.owner)
        guard input.after.changes(from: input.before) == Set(["watch"]) else { throw AlcorAccountSyncFailure.invalid }
        try input.snapshot.validate(userID: input.owner, namespace: "watch")
        try input.receipt.validate(input.mutation, userID: input.owner)
        let scope = AlcorPortfolioRevisionCheckpoint.Scope(origin: "http://synthetic", userID: input.owner, grantID: "synthetic-a", authorization: "portfolio.read", version: 2)
        var cursor = AlcorPortfolioRevisionCheckpoint(scope: scope, value: input.after)
        guard !cursor.unchanged(input.after, scope: scope) else { throw AlcorAccountSyncFailure.invalid }
        cursor.pending = false
        guard cursor.unchanged(input.after, scope: scope) else { throw AlcorAccountSyncFailure.invalid }
        let other = AlcorPortfolioRevisionCheckpoint.Scope(origin: scope.origin, userID: scope.userID, grantID: "synthetic-b", authorization: scope.authorization, version: scope.version)
        guard !cursor.unchanged(input.after, scope: other) else { throw AlcorAccountSyncFailure.invalid }
        print("decoded_actual_http;watch_change_only;receipt_valid;cross_device_cursor_rejected")
    }
}
