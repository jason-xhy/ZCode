/**
 * vim-navigation 标准调用示例：agent 靠模仿写代码，这里放的就是该模仿的那份。
 */
import type { VimNavigationHandlers } from "./contract.js";

/**
 * App 壳把既有命令入口注入 hook，再渲染常驻徽标；模块不持有命令实现。
 * 实际用法：useVimNavigation(handlers) + <VimModeIndicator />（见 App.tsx）。
 */
export function exampleVimNavigation(handlers: VimNavigationHandlers): VimNavigationHandlers {
  return handlers;
}
