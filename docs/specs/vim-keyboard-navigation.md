# Vim 键盘导航规格

状态：已实现，2026-11-23。源码基线 `fec97590`。验证以桌面 E2E 为准；按
[App 单测退役规格](../testing/unit-test-quality.md)，本次不新增 App 业务单测。

## 1. Feature Summary

| 项目        | 内容                                                                                                                                   |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 需求        | 桌面端可选的页面级 Vim 风格键盘导航：普通模式移动/滚动、`f` 标签跳转、`s` 双字符搜索、`?` 帮助                                         |
| 能力/变更层 | 新增 `packages/ui/src/vim` 托管模块（ui 层）；`useAppKeyboard` 的 `Ctrl+[` 让路规则；设置页、命令中心与快捷键三个入口                  |
| 默认状态    | 关闭；开关持久化在 `localStorage["zcode.vim-navigation.enabled"]`，同一窗口内即时生效                                                  |
| 主要入口    | 设置 → 外观 → Vim keyboard navigation；命令中心 “Toggle Vim keyboard navigation”；`CmdOrCtrl+Alt+V`                                    |
| 状态所有者  | `vimStore`（开关、帮助浮层、React 订阅）；`vimOverlayStore`（单次 hint/sneak 会话的瞬时结果）                                          |
| 验证        | `vim-navigation.test.ts`（6 例）与 `vim-quicknav.test.ts`（56 例）；`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed` |
| 非目标      | 不实现 Vim 编辑命令、宏、寄存器、多光标；不接管终端/编辑器的文本编辑语义                                                               |

## 2. 模式、作用域与状态所有权

- 模式由「开关 + 焦点」共同决定：开关关闭或焦点在可编辑元素（输入框、终端、编辑器）时为
  INSERT；否则为 NORMAL。开关关闭时零监听、零按键消费。
- 裸键只在 NORMAL 消费；不进入全局快捷键表，避免抢输入框打字。快捷键内核只保留带修饰键的
  `toggleVimNavigation`。
- `Ctrl+[` 在可编辑目标上是「退出输入态」手势：vim 开启时 `useAppKeyboard` 不再把它交给
  `navigateBack`，浮层输入框同样生效；页面级（非可编辑目标）仍保持原 `navigateBack`。
- `f`/`s` 作用域 = 最顶层可操作浮层：`role=dialog/alertdialog/menu/listbox` 与 Radix
  `data-slot`（dialog/alert-dialog/dropdown-menu/select/context-menu/popover）；
  tooltip 与「内部没有可交互元素」的 hover-card 排除，避免悬停卡劫持裸键与标签。无浮层时
  作用于整页可见内容。
- 标签候选必须与视口及 `overflow: auto/scroll/hidden/clip/overlay` 祖先的 client rect
  求交；完全被裁剪的目标不参与，部分可见保留。
- 覆盖层（模式徽标、帮助、提示/命中）通过 portal 挂到 `document.body`；设置页打开时
  workspace 处于 `opacity-0` + `inert`，普通挂载会导致 vim UI 不可见。
- 视觉复用桌面端语义 token 与共享控件：浮层使用 `bg-popover`、`border-popover-border`
  与 `shadow-md`，提示标签使用 `bg-primary text-primary-foreground`，sneak 命中沿用
  桌面端选中样式 `bg-selected` + `border-primary`（非当前命中用 `border-border-hover`），
  帮助浮层按 Dialog 规格 `rounded-2xl`，键帽使用共享 `Kbd`；不引入独立的琥珀色/自定义
  色板。
- 单一所有者：设置页开关、命令中心与快捷键统一读写 `vimStore`；App 壳只通过
  `VimNavigationHandlers` 注入既有命令入口（命令中心、任务查找、侧栏/终端、会话切换），
  不复制第二套行为。

## 3. 交互与事件顺序

```mermaid
flowchart TD
    A[快捷键 / 命令中心 / 设置开关] --> B[vimStore.enabled]
    B --> C{焦点在可编辑元素?}
    C -->|是| D[INSERT：放行键入；Ctrl+[ / Esc 回 NORMAL]
    C -->|否| E[NORMAL：裸键状态机]
    E --> F[f / s 收集候选]
    F --> G[取最顶层可操作浮层 + 可见性/裁剪过滤]
    G --> H[标签或命中浮层 portal 到 body]
    H --> I[按键前缀匹配]
    I -->|激活| J[目标激活：pointerdown → pointerup → click]
    I -->|Esc / 无匹配| E
    J --> C
```

- `f`/`s` 会话期间所有按键归会话消费；`Esc` 取消后不留持久状态，可立即再次进入。
- Radix 触发器（DropdownMenu/Select）按 `pointerdown → pointerup → click` 序列激活；
  普通按钮只触发一次 `click`；没有 `click()` 的 SVG 元素改发 `MouseEvent("click")`。
- 浮层关闭后若仍有退场动画，E2E 需等待其卸载再开启下一个浮层；产品侧以 `data-state`
  判定刚打开的 Radix 浮层，避免入场动画期间 `opacity=0` 被误判为不可见。

## 4. 输入映射

| 键             | NORMAL 行为                                                      |
| -------------- | ---------------------------------------------------------------- |
| `h` / `l`      | 上一个 / 下一个区域（侧栏、主区）                                |
| `j` / `k`      | 侧栏列表下 / 上移动；主区滚动                                    |
| `gg` / `G`     | 滚动到顶部 / 底部                                                |
| `d` / `u`      | 半页向下 / 向上                                                  |
| `f`            | 为可见可交互元素显示标签，输入标签前缀后激活                     |
| `s`            | 输入两个字符搜索可见文本；`;` / `,` 循环命中，Enter 激活所在控件 |
| `:`            | 打开命令中心                                                     |
| `?`            | 打开 / 关闭帮助浮层；Esc 关闭                                    |
| `Ctrl+[`       | 从 INSERT（含浮层输入框）回 NORMAL                               |
| `Ctrl+Alt+Esc` | 从终端等任意输入态无条件回 NORMAL                                |
| `i`            | 聚焦聊天输入框并进入 INSERT                                      |

## 5. UI Surface Matrix

| 场景 / 入口     | 状态与所有者                  | 行为                                                     |
| --------------- | ----------------------------- | -------------------------------------------------------- |
| 设置 → 外观     | `vimStore`，`Switch`          | 与快捷键、命令中心共用同一开关；关闭时清理帮助浮层       |
| 命令中心        | `toggleVimNavigation` handler | 切换开关；命令带有 `vim/nvim/hjkl/键盘导航` 关键词       |
| 快捷键          | `CmdOrCtrl+Alt+V`             | 只负责开关；裸键不进入全局快捷键表                       |
| 模式徽标 / 帮助 | portal 到 body                | 设置页打开时仍可见；`?`/Esc 关闭帮助                     |
| `f` 提示        | `vimOverlayStore` + portal    | 标签贴在元素框外；滚动后重新 `f` 跟随新视口              |
| `s` 命中        | `vimOverlayStore` + portal    | 无命中保留提示，不静默关窗；Enter 激活命中所在控件       |
| 浮层输入框      | `useAppKeyboard` 让路         | `Ctrl+[` 只退出输入态，不关闭浮层、不触发 `navigateBack` |

## 6. 验收与回归

- E2E（真实 App 壳，2026-11-23 全量执行）：
  - `packages/desktop/test/e2e/ui-shell/navigation/vim-navigation.test.ts`：6/6 PASS
    （开关、NORMAL/INSERT、`?` 帮助、`h/l`、`j`、`f`、`s`、`j/G/gg`、`:`、设置页续导）
  - `packages/desktop/test/e2e/ui-shell/navigation/vim-quicknav.test.ts`：56/56 PASS
    （工作区/会话/设置/命令中心/任务查找/侧栏/终端/Automations/插件商店/Git/文件树/
    Browser/全宽侧栏/对话框族/菜单与下拉族/浮层输入框 `Ctrl+[`/滚动裁剪/sneak 边界）
- 工程门禁：`pnpm typecheck`、`pnpm lint`、`pnpm architecture:check --changed`
  （新增 `vim-navigation` 模块登记）。
- 环境限制（N/A，非缺陷）：自动化不可达的非空列表/生成中队列/长会话虚拟列表/插件安装
  卸载确认/SSH 分享与 Onboarding/Shift+F10 原生菜单入口。

## 7. 边界与非目标

- 开关只影响当前窗口的键盘行为，不改变服务端状态、会话状态或任务执行。
- 提示与搜索只收集已渲染且可见的元素与文本，不查询虚拟列表未渲染内容。
- 终端聚焦时按 INSERT 语义原样放行 shell 键入，不解释裸键。
- 不新增 App 业务单测；交互回归由 E2E 承担，后续变更先维护对应用例再改实现。
