// 浏览器契约类型；业务由 Fire 内置后端统一执行。

export interface CountryCatalogItem {
  mapName: string;
  iso2: string;
  name: string;
  flag: string;
  flagCode: string;
}
