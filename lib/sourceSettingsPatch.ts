/** Defaults and redacted fields are display state, never an implicit provider edit. */
export function sourceSettingsPatch(keys: readonly string[], edited: ReadonlySet<string>, values: Record<string, unknown>): Record<string, string> {
  const patch: Record<string,string> = {};
  for (const key of keys) if (edited.has(key)) {
    if(typeof values[key]!=="string")throw new Error("接口地址格式无效");
    patch[key]=(values[key] as string).trim();
  }
  return patch;
}
