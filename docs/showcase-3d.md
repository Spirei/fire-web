# 3D 展示台（Showcase）——换车 / 换素材指南

首页是一台滚动叙事的 3D 展示台。**引擎只认配置**，换车不用改引擎与组件。
日常加车走**导入向导**（首页右下角车型条末尾的「＋」），不需要改代码、不需要重新发版；
下面第一节是导入向导，后面几节是引擎 / 预设层面的做法（要加一辆随仓库分发的内置车时才用）。

## 文件结构

| 文件 | 作用 |
| --- | --- |
| `components/showcase/types.ts` | 配置类型（镜头关键帧、地面刻度环、隧道光条、后期、章节文案…） |
| `components/showcase/engine.ts` | 引擎：FBO 昼夜环境、反射地面、速度线隧道、流光、后期、轨道相机、缩放与冲刺交互；**不含任何车型常量** |
| `components/showcase/ShowcaseStage.tsx` | React 舞台：渲染 HUD（水印/章节/遥测/按钮/部件标注），挂载后才动态加载 three.js 与引擎 |
| `components/showcase/HomeShowcase.tsx` | 首页外壳：车型清单、按需加载（悬停预热 / 就绪后再切）、右下角车型条 |
| `components/showcase/showcase.css` | 样式，全部限定在 `.showcase` 内 |
| `components/showcase/presets/mcl35m.ts` | 迈凯伦 MCL35M 的预设（模型、镜头、配色、文案），也是导入车型复用的那套「与车型无关」的模板 |
| `components/showcase/presets/models.ts` | 内置车型清单（`SHOWCASE_MODELS`）与「导入参数 → 引擎配置」的拼装函数 |
| `lib/showcaseModels.ts` | 车型登记表（showroom.json）读写：顺序、封面、增删改查 |
| `lib/glbInspect.ts` | 服务端 .glb 体检（导出器、材质、贴图、包围盒；Draco / KTX2 直接拒收） |
| `app/showcase/import/page.tsx` + `components/showcase/ModelImporter.tsx` | 导入向导页面与卡片清单（改参数 / 传封面 / 拖动排序 / 删除） |
| `app/api/showcase/models/*` | 导入相关接口：上传体检、保存参数、保存顺序、封面、删除 |
| `public/mclaren/*` | 随仓库分发的素材：MCL35M 的模型与两张 CC0 HDR 环境贴图 |
| `public/uploads/mclaren/*` | **运行期素材（不进仓库）**：`models/` 导入的 glb、`covers/` 自定义封面、`showroom.json` 登记表 |

## 上线一台新车：导入向导（推荐）

以**管理员**登录后，在首页右下角车型条末尾点「＋」，或直接开 `/showcase/import`（普通用户看不到入口、接口也会 403）：

1. **选文件**：拖入单个 `.glb`（≤ 250MB）。只放模型文件，贴图要已经打进 glb。
2. **体检报告**：服务端会列出导出器、网格 / 材质 / 贴图数量与最大贴图尺寸，并给出建议；
   Draco / Meshopt / KTX2 压缩过的模型会被直接拒收并给改法（导入前先在 Blender 里导出成未压缩的 glb）。
3. **摆正与认轮子**：预览里改车长（归一化比例）、朝向修正、轮子材质（勾中的材质会自转）与贴图上限。
4. **保存并上线**：写进 `public/uploads/mclaren/showroom.json`，首页车型条立刻多一辆车。

之后的日常调整都在导入页的卡片上：**改参数**（不用重新上传，改完再存一次）、**传封面 / 换封面 / 去封面**、
**移出清单**（保留上传的 glb）、**删除并删文件**（连 glb 一起删，注意会同时把卡片移出清单）、
**拖动左上角的 ⠿ 排序**（顺序就是首页右下角车型条的顺序，拖完立即保存）。

素材与登记表都在 uploads 卷里，**不进 Git、不进镜像**：换车 / 调参数不用改代码、不用重新发版；
往 `public/uploads/mclaren/models/` 直接丢 `.glb`（scp / docker cp 都行）也会自动出现在导入页里等人调参数。
封面是卡面上的照片，最长边建议 1600px 左右、单张 ≤ 6MB（PNG / JPG / WEBP）。

## 换一辆随仓库分发的内置车：四步（要改代码）

1. **放素材**：小于 100MB 的模型可以随仓库分发：放进 `public/<你的目录>/`（HDR 可用 Poly Haven 的 CC0 资源）；
   超过 100MB 的（GitHub 单文件上限）放 `public/uploads/mclaren/models/`，靠导入向导管理。
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
- 随仓库分发的内置素材放 `public/mclaren/`；**导入的车型一律放 `public/uploads/mclaren/`**（运行期素材不进仓库、不进镜像，公开仓库审计会拦 100MB+ 的 glb）；
- 车型顺序与封面只以 `public/uploads/mclaren/showroom.json` 为准（顺序表 `order` + 导入车 `cover` + 内置车 `builtinMeta`），不要在前端另存一份偏好；
- 胶囊统一走「展示台胶囊标准」`components/showcase/capsule.css`：加 `class="fire-cap"` 即可（三态 = 常态淡底细描边 / 悬停只亮描边 / 已开启·当前选中·主操作 = 玻璃渐变底 + 亮描边 + 极轻外发光）；尺寸与排版留在各自布局类里，不要再写各自的底色与 hover。首页 HUD 与车型导入页共用这一套，深浅色分别按 `.showcase.light` 与 `:root:not(.dark)` 取变量；
- 章节导航在画面右侧竖直排列：每条 = 一根短横条，当前章节最长最亮（借鉴智能助手的消息轨），右侧那条细竖线是导轨；章节名平时不显示，悬停 / 键盘聚焦才浮在横条左侧（绝对定位，不会把横条挤得左右跳）；点击滚到对应章节（`.sc-nav` / `.sc-nav-tick` / `.sc-nav-label`）。
- 地面倒影（平面反射）：反射贴图**只填高度**（`ground.reflectionSize`），宽度由引擎按画面宽高比推（`reflectSizeFor`）—— 填正方形或填宽度都会让倒影在某一轴上被拉糊；贴图越高倒影越清晰（实测高度 768 → 1024 车身文字明显变清，宽度加 2.7 倍几乎没差别，因为掠射角下倒影在纵向被拉长）。另外整块地面的「天际线接色」只压在极掠射那一条带（`pow(fres, 2)`），否则中景地面被洗平、车身倒影会糊成一片灰雾。调参用 `?mclreflect=1024` 或 `?mclreflect=1638x1024`（只影响诊断），配 `?mclhud=1` 看当前贴图尺寸与帧耗时。
- 换车型是**原地换车**：`ShowcaseStage` 把 config 拆成「外壳签名」（镜头 / 灯光 / 地面 / 文案…）与「车型签名」（素材 + 车型参数），只有外壳变了才重建场景；单纯换车型走 `handle.setModel()` —— 引擎在同一个 WebGL 场景里先解析新车，解析完成后一次性撤旧车、挂新车（`mountCar` / `unmountCar`），镜头、地面、环境、HUD 全程不动，所以没有空白期、也没有加载层。车的挂载逻辑（尺寸归一化 / 材质规则 / 贴图上限 / 清漆 / 发光 / 拆轮子 / 车道朝向 / 包围盒）都收在 `mountCar` 里，**换车型不要另写一套**。
- 冲刺隧道参照本地 `~/Downloads/0.临时/素材/迈凯轮/3D/0919.mp4` 的 14–21 秒：起步先绕至正后方，再落到左后 3/4 跟车位；高速时车在左下、消失点在右上，金色墙灯 / 冷白细线 / 路面短标线分层流动；松手先退光条，再恢复起步前的展示角度与缩放。
  - `speed.chaseCamera` 固定高速距离 / 高度 / 注视高度 / FOV，`chaseAzimuth` 与 `chaseLateral` 控制方位与横移；章节关键帧只负责静置浏览。`speed.response` 控制加速 / 减速响应，`topKmh` 为显示上限（参考约 340）。
  - `speed.tunnel` 的 `bars` / `lanes` 控制暖金墙灯与路标；`barSegment` / `auxCount` / `auxOpacity` / `dof` 控制密度、细线与光晕。光线相位按速度积分 `roadTravel` 推进，禁止用「累计时间 × 当前速度」（减速会倒退 / 跳相位）。
  - `__mcl.debug()` 可检查 `chase` / `roadTravel` / `tunnelStrength` / `tunnelEnabled` / `camera` / `carScreenBox`；停车后 speed / chase / travel / tunnelStrength 为 0，倒影恢复；`tunnel: false` 与 `?mcloff=tunnel` 同时关闭 3D 隧道和屏幕后期。
  - 合并轮胎按轮径与横纵跨度判断，不能用车长 / 车宽比判断单轮（MCL35M 的四轮合并网格恰好约 2.1，会被旧阈值 2.2 误判）。分出的网格保留原局部变换，再绕各自轮心自转。
- 交互约定：滚动 = 叙事推进，`拖拽` = 360° 环视，`⌘/Ctrl/Shift + 滚轮`（或 ZOOM 模式、双指捏合、左下角加减号）= 缩放，`空格 / 按住按钮` = 冲刺（车驶入隧道、轮胎转动），**双击画布（触屏双击）= 回到「固定机位」**：置顶过就回到置顶那一帧（角度 / 缩放由引擎 `setHomePose` 负责，章节进度由组件的 `onResetView` 把滚动带回去），没置顶才回到中立角度（yaw 0 / pitch 0 / zoom 1）。

## 切换车型（首页右下角）

- 车型清单 = **内置**（`presets/models.ts` 的 `SHOWCASE_MODELS`，目前只有随仓库分发的 MCL35M）+ **导入**
  （`public/uploads/mclaren/showroom.json` 里登记的车），两者合成一份后按 `order` 排序。
- 加车走导入向导即可，不用动 `SHOWCASE_MODELS`；内置车同样可以在导入页换封面，
  封面记在 showroom.json 的 `builtinMeta` 里，素材与渲染参数仍随仓库分发。
- 顺序只有一份来源：导入页拖动 → `PUT /api/showcase/models/order` → showroom.json 的 `order`；
  首页右下角车型条与导入页读同一个顺序函数（`resolveOrder`），**顺序表里缺项时内置车补在最前、其余补在末尾**
  （老版本保存顺序时会把内置车过滤掉，留下的脏顺序表靠这条兜底），所以开箱即用时排在最前的仍是内置车。
- 卡面：卡片上方是车型封面，高度按卡宽的 **52%** 给（`aspect-[100/52]`）——这是「车不被切」的临界比例，
  封面按宽度铺满时可见的纵向窗口 = 卡宽 × 52%，再小一点车头 / 轮胎就会被裁掉；没有封面时用车型代号占位。
- 每辆车的关键参数：`model.length`（整车目标长度）、`model.yaw` / `pitch`（朝向不对时修正）、
  `model.wheelPattern`（匹配轮子材质名，例如 `rims|tyres`、`Tyre`、`wheels`）、
  `wheelAxis` / `wheelLateral` / `wheelLongitudinal`（轮子自转轴与左右 / 前后判断轴）、
  `maxTextureSize`（贴图很大的模型收到 2048 省显存）。
- 轮胎网格可能包含单轮、一对或四轮；按每个网格自身坐标中的跨度和圆形截面判断，仅拆存在多轮的轴。MP4/5 前后轮分别位于不同父节点，不能混用其他网格的中线；共用轮胎材质的悬挂保持原状。测量、遮挡和速度验证详见 [隧道参考记录](showcase-tunnel-reference.md)。
- 选中的车型记在 `fire:showcase:model`（刷新保持）；排查缩放 / 朝向可以看 `__mcl.debug().carBox`。

- 自由镜头为右侧第六项：进入后固定叙事进度，普通滚轮缩放、触屏单指环视/俯仰和双指缩放；双击恢复自由镜头初始构图，选择章节退出。最远距离按首帧 FOV、机位、车长与当前画幅估算，目标轮廓不小于 110px 或短边 20%，并限制倍率 1.2–5；以手机 390×844、平板 1024×768 及桌面截图检查最远构图。行驶刻度环在速度区间 4%–28% 渐隐，高速完全关闭。
