# 全站配色与材质

设置 → 配色 → 全站配色为唯一入口；标题栏原窗口风格入口跳转到此处，不再维护窗口独立色板。

| 配色 | 视觉方向 | 材质 |
| --- | --- | --- |
| 中性灰 | 中性表面、石墨强调 | 实色 |
| Liquid Glass | 银白 / 深蓝灰 | 半透明、背景模糊、边缘高光、流动胶囊 |
| 海盐蓝 | 冷白 / 深海蓝 | 实色 |
| 松林绿 | 亚麻白 / 植物绿 | 实色 |
| 琥珀纸 | 暖纸 / 焦糖 | 实色 |
| 暮光紫 | 雾紫 / 墨紫 | 实色 |

`lib/palettes.ts` 为色值单一来源；每套包含 bg、surface、ink、muted、accent、edge、soft 七个语义通道，各有 light / dark 两版。`styles/palettes.css` 将它们映射到 Tailwind 语义色、设置窗口、首页胶囊、模型面板和车型导入页。增加组件优先使用这些语义变量，避免写死浅灰 / 深灰。行情涨跌色、车型贴图、线框指定色及图片保持原意。

材质由 `data-material` 控制，使用 `--material-fill / edge / blur / shadow / highlight / radius`。Liquid Glass 的透明度、边缘与模糊由同一契约提供，实色配色不继续套玻璃效果。模型查看画布保持参考浅灰，控件局部解析所选配色的浅色版本。减少动态效果由现有媒体查询处理；不支持背景模糊时退回不透明表面。

选择属于当前浏览器的个人偏好，以 `usePersistedState("fire:site-palette")` 保存并镜像到 `fire_prefs` Cookie。根布局在服务端输出同一套 data 属性与色值，Provider 同步当前页面与同源标签；刷新无需等待 hydration 才换色。不写全站业务设置、不改变其他用户的偏好。

测试：`node tests/site-palettes.cjs` 检查全部色板、文本对比度与非法值兜底；运行本地服务后执行 `node tests/site-palettes-ssr.cjs` 检查 12 种配色 / 深浅组合的服务端首帧。
