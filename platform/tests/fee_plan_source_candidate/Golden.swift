import Foundation

@main struct Golden {
    static func n(_ value: String) -> Decimal { Decimal(string: value)! }
    static func main() throws {
        let accounts = Array(CommandLine.arguments.dropFirst())
        let revision = accounts.count > 2 ? 2 : 1
        let plans = [
            AlcorPersonalFeePlan(id: "ABCDEF00-0000-4000-8000-000000000001", accountID: accounts[0], providerID: "longbridge", market: .us, effectiveFrom: "2026-01-01", effectiveThrough: nil, overrides: ["commission": revision == 1 ? .free : .init(basis: .percent, rate: n("0.01")), "platform": .init(basis: .share, rate: n("0.000000001234567890123456789"), minimum: 1)], revision: revision, updatedAt: Date(timeIntervalSinceReferenceDate: 12345.125)),
            AlcorPersonalFeePlan(id: "00000000-0000-4000-8000-000000000002", accountID: accounts[0], providerID: "longbridge", market: .hk, effectiveFrom: "2026-01-01", effectiveThrough: nil, overrides: ["commission": .init(basis: .percent, rate: n("0.03"), minimum: 3), "platform": .init(basis: .order, rate: 15)], revision: revision, updatedAt: Date(timeIntervalSinceReferenceDate: 12345.125)),
            AlcorPersonalFeePlan(id: "00000000-0000-4000-8000-000000000003", accountID: accounts[1], providerID: "huatai", market: .cn, effectiveFrom: "2026-01-01", effectiveThrough: "2026-12-31", overrides: AlcorPersonalFeeDefaults.rules(provider: "huatai", market: .cn).reduce(into: [:]) { $0[$1.key.rawValue] = $1.value }, revision: revision, updatedAt: Date(timeIntervalSinceReferenceDate: 12345.125))
        ]
        let encoder = JSONEncoder(); encoder.outputFormatting = [.sortedKeys]
        var encoded: [String] = []
        for plan in plans { try plan.validate(); encoded.append(try encoder.encode(plan).base64EncodedString()) }
        var graduated = AlcorPersonalFeeRule(basis: .share, rate: nil, tiers: [.init(from: 0, rate: n("0.01")), .init(from: 500, rate: n("0.008"))])
        var vectors: [[String:Any]] = []
        func sample(_ name: String,_ rule: AlcorPersonalFeeRule,_ quantity: Decimal,_ price: Decimal,_ before: Decimal? = nil) throws {
            let amount = try rule.amount(quantity: quantity, price: price, side: .buy, monthlyBefore: before)
            vectors.append(["name":name,"rule":try JSONSerialization.jsonObject(with: encoder.encode(rule)),"quantity":NSDecimalNumber(decimal:quantity).stringValue,"gross":NSDecimalNumber(decimal:quantity*price).stringValue,"before":before.map { NSDecimalNumber(decimal:$0).stringValue } as Any? ?? NSNull(),"amount":amount.map { NSDecimalNumber(decimal:$0).stringValue } as Any? ?? NSNull()])
        }
        try sample("unknown",.unknown,1,1)
        try sample("free",.free,1,1)
        try sample("cn-minimum",AlcorPersonalFeeDefaults.rules(provider:"huatai",market:.cn)[.commission]!,100,10)
        try sample("cn-regular",AlcorPersonalFeeDefaults.rules(provider:"huatai",market:.cn)[.commission]!,1000,100)
        try sample("minimum-wins",AlcorPersonalFeeDefaults.rules(provider:"longbridge",market:.us)[.platform]!,1,n("0.1"))
        try sample("cap-wins",.init(basis:.share,rate:10,minimum:5,maximum:2,minimumWins:false),10,1)
        try sample("buy-exempt",.init(basis:.order,rate:3,side:.sell),1,1)
        try sample("half-up",.init(basis:.percent,rate:n("0.005")),1,100)
        try sample("tier-missing",graduated,100,1)
        try sample("tier-cross",graduated,100,1,450)
        graduated.graduated = false
        try sample("whole-tier",graduated,100,1,450)
        try sample("contract",.init(basis:.contract,rate:n("0.65")),2,1)
        let output = try JSONSerialization.data(withJSONObject:["plans":encoded,"vectors":vectors],options:[.sortedKeys])
        FileHandle.standardOutput.write(output)
    }
}
