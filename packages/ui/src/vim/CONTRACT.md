# vim-navigation

意图：让用户只用键盘完成窗口内导航与操作（区域切换、列表选择、滚动、命令中心、
任务查找、easymotion 标签、双字符 sneak），同时不破坏输入框、终端和浮层的原有语义。

不变量：

- 关闭时零监听、零按键消费；开关持久化在 localStorage `zcode.vim-navigation.enabled`。
- 裸键只在 normal 生效；焦点在可编辑元素（输入框/终端/编辑器）= insert，除聊天输入框的
  `Ctrl+[` / `Esc` 外一律放行。生成中或浮层打开时 `Esc` 不抢。
- 命令中心/菜单/对话框打开时裸键让路；`?` 帮助浮层是例外，由本模块自行处理 `?`/`Esc` 关闭。
- `f`/`s` 会话期间所有按键归会话消费；`Esc` 退出后不留任何持久状态。
- 提示/搜索只收集可见视口内元素与已渲染文本，不查询虚拟列表未渲染内容；
  "可见"= 元素自身渲染且祖先不带 `inert`/`aria-hidden`（设置页覆盖时的底层 workspace
  不参与提示、区域轮转与 sneak 搜索）。
- Vim UI（NORMAL/INSERT 徽标、帮助浮层、提示/命中浮层）挂在 `document.body`：
  设置页覆盖 workspace（`opacity-0` + `inert`）时仍然可见可用。
- 提示标签贴在目标元素框外（上方优先、顶部放不下放下方），不覆盖元素本身的文字。

交集：

- 快捷键内核（`shortcuts/`）只负责修饰键组合（`toggleVimNavigation`）；裸键不进入全局
  快捷键表，避免抢输入框打字。
- App 壳通过 `VimNavigationHandlers` 注入六个既有命令入口；本模块不实现命令中心、任务
  查找、侧栏/终端或会话切换。
- 设置页「外观」直接读写 `vimStore` 开关，与快捷键/命令中心共用同一状态源。
- 终端获得焦点后按 insert 语义原样放行 shell 键入；`Ctrl+Alt+Esc` 是无条件回普通模式的兜底。
