/**
 * vim-navigation 对外契约。
 *
 * 模块只做「普通模式裸键 → 既有命令入口」的映射与提示浮层；命令中心、任务查找、
 * 侧栏/终端开关、会话切换的实现仍由 App 壳注入，模块不反向依赖它们。
 * 开关是窗口级 UI 偏好（localStorage `zcode.vim-navigation.enabled`），
 * 模式不是独立状态机：焦点在可编辑元素 = insert，否则 = normal。
 */
export interface VimNavigationHandlers {
  /** 打开命令中心（:）：由 App 壳接到既有 quick pick 入口，模块不持有命令表。 */
  openCommandCenter: () => void;
  /** 任务内查找（/）：复用 App 壳查找框。 */
  findInTask: () => void;
  /** 切换侧栏（b）。 */
  toggleSidebar: () => void;
  /** 切换终端（t）；终端不可写时由 App 壳决定 no-op。 */
  toggleTerminal: () => void;
  /** 上一个任务（[）。 */
  previousConversation: () => void;
  /** 下一个任务（]）。 */
  nextConversation: () => void;
}
