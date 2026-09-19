# 3D 展示台（Showcase）——换车 / 换素材指南

首页是一台滚动叙事的 3D 展示台。**引擎只认配置**，换车不用改引擎与组件。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `components/showcase/types.ts` | 配置类型（镜头关键帧、地面刻度环、隧道光条、后期、章节文案…） |
| `components/showcase/engine.ts` | 引擎：FBO 昼夜环境、反射地面、速度线隧道、流光、后期、轨道相机、缩放与冲刺交互；**不含任何车型常量** |
| `components/showcase/ShowcaseStage.tsx` | React 舞台：渲染 HUD（水印/章节/遥测/按钮/部件标注），挂载后才动态加载 three.js 与引擎 |
| `components/showcase/showcase.css` | 样式，全部限定在 `.showcase` 内 |
| `components/showcase/presets/mcl35m.ts` | 迈凯伦 MCL35M 的预设（模型、镜头、配色、文案） |
| `public/mclaren/*` | 模型（glb）与两张 CC0 HDR 环境贴图 |

## 换一台车：四步

1. **放素材**：把 `car.glb` 与两张 HDR 放进 `public/<你的目录>/`（HDR 可用 Poly Haven 的 CC0 资源）。
2. **复制预设**：复制 `presets/mcl35m.ts` 为 `presets/<你的车>.ts`，改 `assets`、`watermark` 与文案。
3. **对朝向与轮子**：
   - 模型朝向不对：调 `model.yaw`（绕 Y 轴，度）或 `model.pitch`（绕 X 轴，度）；
   - 轮子材质名不同：改 `model.wheelPattern`（正则源码字符串，不区分大小写）与 `wheelAxis` / `wheelLateral` / `wheelLongitudinal` 三个轴；
   - 没有独立轮子（例如整体一个网格）：把 `wheelPattern` 设成不会命中的字符串即可，轮胎就不会自转；
   - 材质太亮/太暗：用 `model.materialRules` 按材质名修正金属度与粗糙度。
4. **换镜头**：`camera.keyframes` 就是镜头脚本，`p` 是滚动进度 0–1，方位角 `az` 0° 正对车头、90° 车身左侧、180° 车尾；`r` 距离、`h` 高度、`ty`/`tz` 注视点、`fov` 视角。想加一个特写就在对应进度插一条。

最后把首页换成自己的预设：

```tsx
// app/page.tsx
import ShowcaseStage from "@/components/showcase/ShowcaseStage";
import { MY_CAR_SHOWCASE } from "@/components/showcase/presets/my-car";

export default function HomePage() {
  return <ShowcaseStage config={MY_CAR_SHOWCASE} />;
}
```

## 效果开关（配置里可整块关掉）

- `ground.ring: false`：不要车下方的钟面刻度环；
- `speed.tunnel: false`：不要速度线隧道；
- `speed.tunnel.bars`：主光条列表（角度、宽度、暖金或冷白），留空就只有很浅的虚线；
- `post`：曝光、Bloom、拖影强度；`zoom`：缩放范围。

## 约定

- 配置要能从服务端组件传给客户端组件，所以**正则一律写成字符串**（引擎内部再 `new RegExp(..., "i")`），不要直接写 `/.../ `；
- 素材放 `public/` 下，不要放 `public/uploads/`（那是部署期的用户上传目录，公开仓库审计会拦）；
- 交互约定：滚动 = 叙事推进，`拖拽` = 360° 环视，`⌘/Ctrl/Shift + 滚轮`（或 ZOOM 模式、双指捏合、左下角加减号）= 缩放，`空格 / 按住按钮` = 冲刺（车驶入隧道、轮胎转动）。

## 切换车型（首页右下角）

- 车型清单在 `components/showcase/presets/models.ts`：每辆车 = 一份 `ShowcaseConfig`（素材路径 + 车型参数覆盖），
  镜头、隧道、地面、后期这些与车型无关的部分直接复用 MCL35M 那一套。
- 加了新车只要：把 glb 放进 `public/mclaren/`（单文件超过 100 MB 的放 `public/uploads/mclaren/models/`，
  这份目录不进仓库、部署时手动拷到 uploads 卷），然后在 `SHOWCASE_MODELS` 里补一条。
- 每辆车的关键参数：`model.length`（整车目标长度）、`model.yaw` / `pitch`（朝向不对时修正）、
  `model.wheelPattern`（匹配轮子材质名，例如 `rims|tyres`、`Tyre`、`wheels`）、
  `wheelAxis` / `wheelLateral` / `wheelLongitudinal`（轮子自转轴与左右 / 前后判断轴）、
  `maxTextureSize`（贴图很大的模型收到 2048 省显存）。
- 轮子有两种建模方式：一个材质盖四个轮子（本车，引擎按象限拆成四个）与一个网格一个轮子
  （Gulf / MP4 系列，引擎按网格跨度自动识别为单轮）。识别错时表现为轮子被切碎。
- 选中的车型记在 `fire:showcase:model`（刷新保持）；排查缩放 / 朝向可以看 `__mcl.debug().carBox`。
