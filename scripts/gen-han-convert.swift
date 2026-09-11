import Foundation

// 用系统 ICU 的「Traditional-Simplified」转换，把 CJK 基本区里所有「繁≠简」的字挑出来，
// 输出成两行：第一行繁体字串、第二行对应简体字串（同下标一一对应）。
var trad = ""
var simp = ""
for scalar in 0x3400...0x9FFF {
    guard let u = UnicodeScalar(scalar) else { continue }
    let ch = String(Character(u))
    guard ch.range(of: "\\p{Han}", options: .regularExpression) != nil else { continue }
    let mutable = NSMutableString(string: ch) as CFMutableString
    CFStringTransform(mutable, nil, "Traditional-Simplified" as CFString, false)
    let out = mutable as String
    if out != ch, out.count == 1 {
        trad += ch
        simp += out
    }
}
print(trad)
print(simp)
