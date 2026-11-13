# ADR-BROWSERCTL-002 — 上下文高效的读取层（`browser_read`）

状态：已决策；实现随 `packages/browser-control/src/read.ts` 与 `route.ts` 的 `digest()` 落地。本记录是 `WP-BCTL-002` 的前置决策，不新增 `SEC-*`，不改变 `SEC-52` 的既有声明。

来源：在 `0.1.0-alpha.8` 范围内，用户要求把其本人项目 `dsh-inner-browser-use` 的读取算法吸收进 Browser Control，并指出真正的目标是「避免长 DOM 树污染上下文」。本记录按 §30.4 回答五个问题，并明确记录吸收范围与拒绝范围。

## 背景

`browser_view` 返回整页文本加编号控件。在小页面上这是正确的默认；在长页面上它把「这一页说了什么」和「我要的那一句」以同样的价格交给模型，而后者通常只占前者的百分之一。这是当前 Browser Control 唯一已知的、可量化的上下文浪费，且与 `KILL-K1`（路由不可观测）无关：它不改变能否观测，只改变观测结果的体积。

同时必须承认边界：任何把「读得少」变成「理解页面」的做法，都需要一个判断层。判断层可以由模型来做（要一次额外调用、要网络、要钱），也可以由本进程的排序算法来做（不要调用、不要网络、只多几毫秒）。本 ADR 选择后者，并把它的局限写在代码和文档里，而不是留给人去猜。

## 决策

1. **只做读取侧的投影，不做判断的替代。** 新增四个读取模式：`article`（Markdown 列）、`map`（大纲与计数）、`query`（只给回答问题的段落）、`changed`（只给与上次读取的差异）。四个模式都只读页面，都不点击、不输入、不导航。
2. **排序在本进程内完成。** 不调用模型，不发网络请求，不引入第三方库。词项折叠、饱和打分、长度归一、覆盖率加权、链接密度与散文质量惩罚、MMR 去重全部是纯函数，位于 `src/read.ts`，可单测。
3. **新增工具，不改旧工具。** `browser_view` 的语义、默认值与输出格式一字不改。`browser_read` 是第十一个工具，宿主不调用它时不存在任何成本。
4. **字符预算是字符，不是 token。** `maxChars` 默认 2000、下限 200、上限 24000。文档必须写明同样字符数在中文比英文贵，不得把它描述成 token 预算。
5. **`changed` 只与同投影、同地址的上一次读取比较。** 首次读取返回整页而不是「无变化」；页面已导航则重新建立基线。把 `article`/`map` 的结果当作 `changed` 的基线会把两种投影的差异当成页面变化，这是错报，必须排除。
6. **吸收的来源与许可。** 算法吸收自用户本人项目 `dsh-inner-browser-use`（MIT，`Copyright (c) 2026 regrevia`），该包与本仓库同一作者。`read.ts` 头部保留来源声明，`NOTICE` 无需变更：没有逐字复制的文件，代码是按本仓库的类型与错误模型重写的。包装形态（Cordis 插件 + 右侧栏客户端）不吸收，见下。
7. **不宣称这是 Computer Use。** 读取层的存在不改变 §2.5 与 §42.1 的结论。本层不写页面、不驱动指针键盘、不接管 Native 调用，因此仍然是 `SEC-52` 内的一条 opt-in 路由；写侧若要扩大，必须按 §42.1 的三个选项单独决策，不得以「反正已经有 CDP 连接」为由顺延。

## 吸收与拒绝

| 来源                                                                       | 处理             | 理由                                                                                                                                                |
| -------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------------------------------------ |
| `read.js` 的 `blocks`/`terms`/`fold`/`rank`/`sentences`/`evidence`/`brief` | 吸收并重写       | 纯函数，与本仓库无冲突；`fold` 增加 `undouble` 使 `shipping`→`ship`、`cancelled`→`cancel` 与 `refund`/`refunds` 落在同一词项                        |
| `blocksExpression`/`articleExpression` 的页面内取值                        | 吸收并改造       | 页面表达式返回 JSON 文本，由 `evaluate` 交给路由解析；预算做 `Math.trunc(budget)                                                                    |     | N`兜底，避免非有限值把`NaN` 插进源码 |
| `differs`                                                                  | 吸收并收紧       | 收紧为「只与同投影同地址比较」，见决策 5                                                                                                            |
| `blindSpots`/`sampled: false`                                              | 部分吸收         | 以 `matched`/`total` 与 `truncated` 表达「没展示的部分」，不改写成能力声明                                                                          |
| `pixels.js`、`browser_look` 式的字母网格                                   | 暂不吸收         | 与本次目标（文本上下文）无关；自绘页面另开工件评估                                                                                                  |
| Cordis 插件形态、右侧栏客户端、`dsh.bundle.patch`                          | 拒绝             | 本仓库的 Browser Control 是 MCP stdio 服务（`ADR-BROWSERCTL-001` 决策 4）；换包装会推翻该 ADR                                                       |
| 该包在文档中自报的节省比例                                                 | 不作为本仓库证据 | 那是它的单 fixture 自测；本仓库的「未测量不写数字」规则要求自己重跑。本 ADR 引用的是 `tests/browser-control-digest-live.test.ts` 在同一机器上的输出 |

## 相对来源包的四点差异

1. **引用编号跨读取稳定。** 编号按元素身份记录在页面侧（`window.__oxrailRefs` 的 `WeakMap`），同一个控件在重读后拿回同一个编号，因此 `changed` 是增量而不是重新编号，上一轮的 `ref` 在重读后仍指向它（页面导航后该存储随元素一起消失，编号从头开始）。这条曾**写错**：初稿照来源包的设计写成「与内容指纹一起记录」，与当时 `route.ts` 里 `const ref = controls.length + 1` 的事实相反——按 DOM 顺序每次从 1 重编号。审计代码时发现并按上述方式实现，由 `tests/browser-control-digest-live.test.ts` 的 `refs.stable` 与 `tests/browser-control-read.test.ts` 的页面表达式断言两处固定。
2. **预算是 token 意识而非字符口号。** 文档与实现都按字符计并明说中英差异，不把字符数换算成 token 数。
3. **两级下钻。** `map` 与全文之间多了 `query`，可以只取相关段落、再按 `region` 扩张，而不是在「大纲」和「整页」之间二选一。
4. **分层的上限。** 控件（`MAX_CONTROLS` 160）、正文（`maxChars`）、块（`blocksExpression` 预算）、答案段落（`limit` 24）各有各自的上限；但溢出**只**以 `truncated` 一个布尔加 `matched`/`total` 报告，不是每个角色一份计数。初稿写成「各自报告溢出量」同样说过头了，按实现改为现状。

## §30.4 的五个问题

**1. 哪个已量化瓶颈无法由现有方案解决。**
长页面读取把整页塞进上下文，而回答通常只用到其中极小一部分。已在同机同 fixture 上量化：整页 5974 字符，`map` 45，`query` 89。这不是速度瓶颈，是上下文预算瓶颈。

**2. 对权限、攻击面、安装和 NIF 的影响。**
零新增权限：四个模式都只读当前已加载页面，不新增 CDP 域，不写页面，不发网络请求（排序在进程内）。不新增端口、不新增进程、不新增 Hook 事件。NIF 与 paired benchmark 不受影响，且 `browser_*` 用例不得计入 NIF。

**3. token/延迟的净成本。**
默认关闭时为零。启用时每次 `browser_read` 是页面内一次取值加一次进程内排序，实测个位数毫秒；成本是输出字符数。反例必须写在文档里：在纯散文页面上 `article` 不比 `browser_view` 小（实测 6061 vs 5974），因为它把编号控件行换成了标题与列表标记。节省来自 `query`/`map`/`changed`，不是来自「读取模式一定更短」。

**4. 可删除路径。**
删除 `src/read.ts`、`digest()`、`browser_read` 工具与相关测试；文档删去对应章节；ADR 标为 superseded。`browser_view` 不受影响，`SEC-52` 文本不变，因此删除不需要规范版本号回滚之外的任何迁移。

**5. 对应 Work Package、Benchmark 与 Kill Criteria。**
`WP-BCTL-002`（依赖 `WP-BCTL-001`）。不并入 NIF，不参与 paired benchmark。相关 kill criteria：`KILL-K12`（若为了读得更准而需要点击、输入或导航，则本层越界，必须退回只读或杀死）、`KILL-K18`（若为了实现排序而重写最终坐标、路径、按键、点击或焦点，终止该实现）、`KILL-K34`（不得被报告为 Hook-visible / Guard-mediated / 与 Native 等价）。

## 证据边界

- 数字来自 `tests/browser-control-digest-live.test.ts`，一个 `data:text/html` fixture（40 个近似重复段落、3 个标题、60 个链接、1 个答案），在同一台 macOS 机器上一次 headless Chrome 会话内测得。它是回归基线，不是跨页面基准。
- 该测试需要 `OXRAIL_BROWSER_LIVE=1`，默认跳过；CI 不跑真实 Chrome 时这些数字不会被重新生成。
- 未测量、因此未声明的内容：真实站点的节省比例、中文页面的字符/token 关系、跨标签页汇总、iframe 与 shadow DOM 内的可读性（当前读取层不进入 iframe，也不展开未打开的 shadow root）。
