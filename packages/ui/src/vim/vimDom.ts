/**
 * Vim 导航的 DOM 适配层：区域、任务项、滚动容器与输入框定位。
 *
 * 设计原则：
 * - 只依赖稳定的语义选择器（侧栏 testid / main 元素 / 时间线滚动标记 / 任务项标记），
 *   不把 React 组件树结构写死，应用布局调整时失效面可控；
 * - 所有查询都做可见性过滤：隐藏的 workspace / 收起的面板不参与区域轮转与列表移动。
 */

export const VIM_SIDEBAR_SELECTOR = '[data-testid="sidebar"]';
export const VIM_MAIN_SELECTOR = "main";
export const VIM_TIMELINE_SCROLL_SELECTOR = '[data-v4-timeline-scroll="true"]';
export const VIM_COMPOSER_SELECTOR = '[data-testid="v4-composer-input"]';
export const VIM_STOP_CONTROL_SELECTOR = '[data-testid="v4-stop"]';
const NAV_ITEM_SELECTOR = [
  "[data-task-item-key]",
  '[data-testid^="task-item-"]',
  '[data-testid="virtual-project-row"]',
].join(", ");

export type VimRegionId = "sidebar" | "main";

export interface VimRegion {
  id: VimRegionId;
  element: HTMLElement;
}

let activeRegionId: VimRegionId | null = null;
/** 记住最近聚焦的列表项：h/l 在侧栏与主区之间往返时回到原位而不是永远跳第一条。 */
let lastFocusedNavItem: HTMLElement | null = null;

/**
 * 可见性判定：接受任意 Element。
 *
 * 不能只认 HTMLElement：recharts 的 accessibility layer 是
 * `svg[role="application"][tabindex="0"]`，SVGSVGElement 属于 Element 而非
 * HTMLElement；用 `instanceof HTMLElement` 会把所有可聚焦 SVG 控件在候选
 * 过滤阶段直接丢掉（Q3-01）。isConnected/checkVisibility/getClientRects
 * 都是 Element 级 API，Chromium 对 SVG 同样可用。
 *
 * 谓词写成 `element is Element`：输入为 `HTMLElement | null` 的调用点仍会
 * 收窄到 HTMLElement（交叉类型），区域/任务项/滚动等既有逻辑的类型不变。
 */
export function isVisible(element: Element | null): element is Element {
  if (!(element instanceof Element) || !element.isConnected) {
    return false;
  }
  // 设置页等覆盖层会把底层工作区整体标成 inert + aria-hidden（保留布局、只关交互）。
  // checkVisibility 只看元素自身样式，看不到祖先的 inert/aria-hidden，会让隐藏层的
  // 任务行、文本继续参与区域轮转、j/k 移动与 sneak 搜索——表现为"看得见的目标不动、
  // 看不见的旧页面被操作"。
  if (element.closest("[inert], [aria-hidden='true']")) {
    return false;
  }
  const checkVisibility = (
    element as Element & {
      checkVisibility?: (options?: Record<string, boolean>) => boolean;
    }
  ).checkVisibility;
  if (typeof checkVisibility === "function") {
    return checkVisibility.call(element, {
      opacityProperty: true,
      visibilityProperty: true,
      contentVisibilityAuto: true,
    });
  }
  return element.getClientRects().length > 0;
}

/** 当前可见的导航区域，按「侧栏 → 主区」固定顺序。 */
export function listVimRegions(): VimRegion[] {
  const regions: VimRegion[] = [];
  const sidebar = document.querySelector<HTMLElement>(VIM_SIDEBAR_SELECTOR);
  if (isVisible(sidebar)) {
    regions.push({ id: "sidebar", element: sidebar });
  }
  const main = Array.from(document.querySelectorAll<HTMLElement>(VIM_MAIN_SELECTOR)).find(
    (candidate) => isVisible(candidate),
  );
  if (main) {
    regions.push({ id: "main", element: main });
  }
  for (const region of regions) {
    region.element.setAttribute("data-vim-region", region.id);
  }
  return regions;
}

export function resolveRegionForElement(element: Element | null): VimRegion | null {
  if (!element) {
    return null;
  }
  for (const region of listVimRegions()) {
    if (region.element.contains(element)) {
      return region;
    }
  }
  return null;
}

export function getActiveRegion(): VimRegion | null {
  const regions = listVimRegions();
  if (regions.length === 0) {
    return null;
  }
  const fromFocus = resolveRegionForElement(document.activeElement);
  if (fromFocus) {
    activeRegionId = fromFocus.id;
    return fromFocus;
  }
  const stored = regions.find((region) => region.id === activeRegionId);
  return stored ?? regions[regions.length - 1] ?? null;
}

/** 活动区域根元素（sneak 文本搜索范围）；无区域时为 null。 */
export function getActiveRegionElement(): HTMLElement | null {
  return getActiveRegion()?.element ?? null;
}

export function markActiveRegion(region: VimRegion | null): void {
  activeRegionId = region?.id ?? null;
  for (const element of document.querySelectorAll<HTMLElement>("[data-vim-region]")) {
    if (region && element === region.element) {
      element.setAttribute("data-vim-active", "true");
    } else {
      element.removeAttribute("data-vim-active");
    }
  }
}

function ensureFocusable(element: HTMLElement): void {
  if (!element.hasAttribute("tabindex")) {
    element.setAttribute("tabindex", "-1");
  }
}

function focusElement(element: HTMLElement, preventScroll = true): void {
  ensureFocusable(element);
  element.focus({ preventScroll });
  markActiveRegion(resolveRegionForElement(element));
}

/** 区域内的可导航项（任务行 / 项目行），按 DOM 顺序、过滤隐藏项。 */
export function getNavItems(region: VimRegion | null): HTMLElement[] {
  if (!region) {
    return [];
  }
  return Array.from(region.element.querySelectorAll<HTMLElement>(NAV_ITEM_SELECTOR)).filter(
    (item) => isVisible(item),
  );
}

export function focusNavItem(item: HTMLElement): void {
  lastFocusedNavItem = item;
  focusElement(item, true);
  item.scrollIntoView({ block: "nearest", inline: "nearest" });
}

/** 在活动区域的列表内移动；返回 false 表示该区域没有可移动项（调用方改走滚动）。 */
export function moveNavSelection(delta: number): boolean {
  const region = getActiveRegion();
  const items = getNavItems(region);
  if (items.length === 0) {
    return false;
  }
  const active = document.activeElement;
  const currentIndex =
    active instanceof HTMLElement
      ? items.findIndex((item) => item === active || item.contains(active))
      : -1;
  let nextIndex: number;
  if (currentIndex < 0) {
    nextIndex = delta > 0 ? 0 : items.length - 1;
  } else {
    nextIndex = Math.min(items.length - 1, Math.max(0, currentIndex + delta));
  }
  focusNavItem(items[nextIndex]!);
  return true;
}

/** 跳到列表首/尾；返回 false 表示该区域没有可移动项（调用方改走滚动）。 */
export function focusNavEdge(edge: "first" | "last"): boolean {
  const items = getNavItems(getActiveRegion());
  if (items.length === 0) {
    return false;
  }
  focusNavItem(edge === "first" ? items[0]! : items[items.length - 1]!);
  return true;
}

/** 从活动区域切换焦点到相邻区域；只有主区/侧栏两个可见区域时等价于 h/l。 */
export function focusAdjacentRegion(direction: 1 | -1): boolean {
  const regions = listVimRegions();
  if (regions.length === 0) {
    return false;
  }
  const current = getActiveRegion();
  const currentIndex = current ? regions.findIndex((region) => region.id === current.id) : -1;
  const nextIndex =
    currentIndex < 0
      ? direction > 0
        ? 0
        : regions.length - 1
      : (currentIndex + direction + regions.length) % regions.length;
  focusRegion(regions[nextIndex]!);
  return true;
}

export function focusRegion(region: VimRegion): void {
  markActiveRegion(region);
  if (region.id === "sidebar") {
    const items = getNavItems(region);
    const active = document.activeElement;
    const focused =
      active instanceof HTMLElement
        ? items.find((item) => item === active || item.contains(active))
        : undefined;
    const remembered =
      lastFocusedNavItem && items.includes(lastFocusedNavItem) ? lastFocusedNavItem : undefined;
    const target = focused ?? remembered ?? items[0] ?? region.element;
    focusElement(target, Boolean(focused ?? remembered));
    if (!focused && !remembered && items[0]) {
      items[0].scrollIntoView({ block: "nearest" });
    }
    return;
  }
  const timeline = region.element.querySelector<HTMLElement>(VIM_TIMELINE_SCROLL_SELECTOR);
  focusElement(timeline ?? region.element);
}

function isScrollable(element: HTMLElement): boolean {
  const style = window.getComputedStyle(element);
  return (
    /(auto|scroll|overlay)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1
  );
}

function nearestScrollable(element: Element | null): HTMLElement | null {
  let current: Element | null = element;
  while (current && current !== document.body && current !== document.documentElement) {
    if (current instanceof HTMLElement && isScrollable(current)) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

/** 当前应滚动的容器：焦点祖先优先，其次主区时间线，最后区域内最大滚动面。 */
export function resolveScrollTarget(): HTMLElement | null {
  const fromFocus = nearestScrollable(document.activeElement);
  if (fromFocus) {
    return fromFocus;
  }
  const region = getActiveRegion();
  if (!region) {
    return null;
  }
  const timeline = region.element.querySelector<HTMLElement>(VIM_TIMELINE_SCROLL_SELECTOR);
  if (timeline && isVisible(timeline)) {
    return timeline;
  }
  const candidates = Array.from(region.element.querySelectorAll<HTMLElement>("*")).filter(
    (element) => isVisible(element) && isScrollable(element),
  );
  candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
  return candidates[0] ?? null;
}

export function scrollByLines(lines: number): void {
  const target = resolveScrollTarget();
  if (!target) {
    return;
  }
  target.scrollBy({ top: lines * 72, behavior: "auto" });
}

export function scrollHalfPage(direction: 1 | -1): void {
  const target = resolveScrollTarget();
  if (!target) {
    return;
  }
  target.scrollBy({ top: (direction * target.clientHeight) / 2, behavior: "auto" });
}

export function scrollFullPage(direction: 1 | -1): void {
  const target = resolveScrollTarget();
  if (!target) {
    return;
  }
  target.scrollBy({ top: direction * target.clientHeight * 0.9, behavior: "auto" });
}

export function scrollToEdge(edge: "top" | "bottom"): void {
  const target = resolveScrollTarget();
  if (!target) {
    return;
  }
  target.scrollTo({ top: edge === "top" ? 0 : target.scrollHeight, behavior: "auto" });
}

/** 聚焦聊天输入框（i / a）；只选可见实例，避免命中侧栏草稿等隐藏输入框。 */
export function focusComposer(): boolean {
  const candidates = Array.from(
    document.querySelectorAll<HTMLElement>(VIM_COMPOSER_SELECTOR),
  ).filter(isVisible);
  const editor = candidates[0];
  if (!editor) {
    return false;
  }
  editor.focus({ preventScroll: true });
  if (editor.isContentEditable) {
    const selection = window.getSelection();
    if (selection) {
      const range = document.createRange();
      range.selectNodeContents(editor);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
    }
  }
  return true;
}

export function isEditableElement(element: Element | null): boolean {
  if (!(element instanceof HTMLElement)) {
    return false;
  }
  if (element.isContentEditable) {
    return true;
  }
  return (
    element.tagName === "INPUT" || element.tagName === "TEXTAREA" || element.tagName === "SELECT"
  );
}

/** 回到普通模式：移出输入框焦点，焦点落到主区滚动容器。 */
export function exitToNormalMode(): void {
  if (isEditableElement(document.activeElement)) {
    (document.activeElement as HTMLElement).blur();
  }
  const main = listVimRegions().find((region) => region.id === "main");
  if (main) {
    const timeline = main.element.querySelector<HTMLElement>(VIM_TIMELINE_SCROLL_SELECTOR);
    focusElement(timeline ?? main.element);
  }
}

/** 生成中（停止按钮可见）时 Escape 属于应用语义，vim 层不得抢。 */
export function hasVisibleStopControl(): boolean {
  return Array.from(document.querySelectorAll<HTMLElement>(VIM_STOP_CONTROL_SELECTOR)).some(
    isVisible,
  );
}

/**
 * “可交互元素”选择器：hint 候选与浮层可操作性判定共用。
 *
 * 浮层里没有任何这类元素时只是纯提示（如信息型 hover-card），不能吞按键；
 * 任务行悬停卡正是在 content 上标了 role=tooltip、内部 0 个可交互元素。
 */
export const VIM_INTERACTIVE_SELECTOR = [
  "a[href]",
  "button",
  "summary",
  "input:not([type=hidden])",
  "textarea",
  "select",
  // 聊天输入框（Lexical）是 div[role=textbox][contenteditable]，不是原生 input。
  '[contenteditable="true"]',
  '[role="textbox"]',
  '[role="button"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="checkbox"]',
  '[role="switch"]',
  '[role="radio"]',
  '[role="link"]',
  '[tabindex="0"]',
].join(", ");

/**
 * 可交互浮层的内容节点：对话框/告警框/菜单/列表/弹层。
 *
 * Radix 的 content 都会带 data-slot（dialog-content / alert-dialog-content /
 * dropdown-menu-content / select-content / context-menu-content / popover-content…），
 * 但不同 primitive 的 role 不统一（popover 无 role、alertdialog 不是 dialog），
 * 只认 role=dialog 会把菜单/下拉/告警框全部漏掉。
 */
export const VIM_OVERLAY_SELECTOR = [
  '[role="dialog"]',
  '[role="alertdialog"]',
  '[role="menu"]',
  '[role="listbox"]',
  '[data-slot="dialog-content"]',
  '[data-slot="alert-dialog-content"]',
  '[data-slot="dropdown-menu-content"]',
  '[data-slot="dropdown-menu-sub-content"]',
  '[data-slot="select-content"]',
  '[data-slot="context-menu-content"]',
  '[data-slot="context-menu-sub-content"]',
  '[data-slot="popover-content"]',
  '[data-slot="hover-card-content"]',
].join(", ");

/**
 * tooltip / 纯展示 hover-card 不是可操作浮层。
 *
 * Radix Tooltip 与 HoverCard 是“跟随悬停/焦点出现、离开即消失”的提示层：
 * - 显式 role=tooltip 的一律排除（任务行悬停卡 `task-row-details`，Q2-18）；
 * - Radix HoverCard primitive 默认不写 role，但内容里没有任何可交互元素时
 *   同样只是提示，按“无交互 hover-card”排除；带按钮/链接的 hover-card 仍
 *   保留为可操作浮层（f/s 可在卡片内作用）。
 *
 * 不能只按 data-testid 排除：所有 tooltip 角色/纯信息卡都走同一判据。
 */
function isTooltipLikeOverlay(element: HTMLElement): boolean {
  if (element.matches('[role="tooltip"]') || element.closest('[role="tooltip"]')) {
    return true;
  }
  if (element.matches('[data-slot="hover-card-content"]')) {
    return element.querySelector(VIM_INTERACTIVE_SELECTOR) === null;
  }
  return false;
}

/**
 * 浮层可见性判据。
 *
 * 不能直接用 isVisible：Radix 的浮层有 100ms 的 fade-in/zoom-in，刚按下回车/指针
 * 打开时 opacity 还是 0，isVisible 会把刚打开的菜单判成“不存在”，f/s 于是回落到
 * 整个页面并给背景打标签（Q1-23 实锤）。浮层只需要“已挂载、未在关闭动画、有布局
 * 尺寸、未被 inert/aria-hidden 遮住”；透明度交给子元素自身判断。
 */
function isOverlayCandidate(element: HTMLElement): boolean {
  if (!element.isConnected) {
    return false;
  }
  if (element.closest("[inert], [aria-hidden='true']")) {
    return false;
  }
  if (isTooltipLikeOverlay(element)) {
    return false;
  }
  // Radix Presence 在关闭动画期间仍保留节点：data-state=closed 不算打开。
  const state = element.getAttribute("data-state");
  if (state === "closed") {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width <= 2 || rect.height <= 2) {
    return false;
  }
  // Radix 的 data-state=open 是权威状态：入场动画前 100ms opacity 仍为 0，
  // 不能因此漏掉刚打开的菜单/对话框。没有 data-state 的自定义浮层则要求
  // 真实可见——否则常驻但 opacity:0 的容器会被误判成打开浮层，吞掉 i/h/l
  //（VIM-01/02 回归实锤）。
  return state === "open" || isVisible(element);
}

/** 当前打开的浮层内容节点（文档顺序 = 挂载顺序，后者更顶层）。 */
export function listOpenOverlays(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>(VIM_OVERLAY_SELECTOR)).filter(
    isOverlayCandidate,
  );
}

/**
 * 最顶层可见浮层作用域。
 *
 * 取“最后一个未被其它浮层包含的节点”：cmdk 的 listbox 嵌在命令中心 dialog 内，
 * 直接取文档最后一个会把作用域缩到选项列表；嵌套命中统一归并到外层 dialog。
 * 独立的 Radix 菜单/下拉是 body 下的同级 portal，挂载更晚，仍会胜出。
 */
export function getTopmostOverlay(): HTMLElement | null {
  const candidates = listOpenOverlays();
  const roots = candidates.filter(
    (candidate) => !candidates.some((other) => other !== candidate && other.contains(candidate)),
  );
  return roots[roots.length - 1] ?? null;
}

/** 元素是否位于某个可见浮层内（用于区分浮层输入框与页面输入框）。 */
export function isInsideOpenOverlay(element: Element | null): boolean {
  if (!(element instanceof Element)) {
    return false;
  }
  const overlay = element.closest<HTMLElement>(VIM_OVERLAY_SELECTOR);
  return overlay !== null && isOverlayCandidate(overlay);
}

/**
 * 把焦点从浮层内的输入框移到浮层容器上（浮层保持打开）。
 * 输入框仍保留自己的文本，只是退出 typing 态，随后 f/s 由 vim 层接管。
 */
export function focusOverlayContainer(overlay: HTMLElement): void {
  ensureFocusable(overlay);
  overlay.focus({ preventScroll: true });
}

/** 弹窗/菜单/列表打开时，按键归浮层所有（Escape 关闭、方向键选择）。 */
export function hasOpenOverlay(): boolean {
  if (listOpenOverlays().length > 0) {
    return true;
  }
  // 第三方/未来 primitive 未必带 role 或 data-slot：保留 popper 容器探测。
  // 但 tooltip 与纯展示 hover-card 只是提示、不是可操作浮层，不能因为它们
  // 吞掉 normal 键与 f/s（Q2-18 回归实锤：任务行悬停卡是 popper 里的
  // hover-card-content + role=tooltip，仅靠下面这层兜底也会误判）。
  return Array.from(document.querySelectorAll<HTMLElement>("[data-radix-popper-content-wrapper]"))
    .filter(isVisible)
    .some((wrapper) => {
      // Presence 卸载后可能留下空 wrapper（关闭动画尾帧），不构成浮层。
      if (wrapper.childElementCount === 0) {
        return false;
      }
      if (wrapper.querySelector('[data-slot="tooltip-content"], [role="tooltip"]')) {
        return false;
      }
      const hoverCard = wrapper.querySelector<HTMLElement>('[data-slot="hover-card-content"]');
      return hoverCard === null || hoverCard.querySelector(VIM_INTERACTIVE_SELECTOR) !== null;
    });
}
