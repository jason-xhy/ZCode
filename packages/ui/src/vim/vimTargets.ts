/**
 * easymotion 式提示目标收集 + sneak 式文本命中查找。
 *
 * - 提示目标 = 当前视口内可见、可交互的元素（按钮/链接/菜单项/输入控件/任务行）；
 * - 标签用 home-row 键，一字符最多覆盖 26 个目标，超出即统一两字符；
 * - sneak 命中搜索整个可见页面（对话框打开时只看对话框），不再按"活动区域"截断：
 *   用户在设置页/主区/侧栏都能直接搜到目标文本，不因上次 h/l 的落点而失效。
 */
import { isVisible, VIM_INTERACTIVE_SELECTOR } from "@/vim/vimDom.js";

const CLICKABLE_SELECTOR = VIM_INTERACTIVE_SELECTOR;

const HINT_LABEL_CHARS = "asdfghjklqwertyuiopzxcvbnm";
const MAX_HINT_TARGETS = 400;
const MAX_SNEAK_MATCHES = 80;

export interface HintTarget {
  label: string;
  /** 任意 Element：可聚焦 SVG（recharts accessibility layer）不是 HTMLElement。 */
  element: Element;
  rect: DOMRect;
}

export interface SneakMatch {
  rect: DOMRect;
  container: HTMLElement;
  element: Element | null;
}

function intersectsViewport(rect: DOMRect): boolean {
  return (
    rect.width > 2 &&
    rect.height > 2 &&
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth
  );
}

/** 会裁剪子元素的 overflow 值（visible 不裁剪，其余都按裁剪处理）。 */
const CLIPPING_OVERFLOW = /^(auto|scroll|hidden|clip|overlay)$/;

/** transform/filter 等会为 absolute/fixed 后代建立 containing block 的属性。 */
function hasTransformLikeStyle(style: CSSStyleDeclaration): boolean {
  const set = (value: string | undefined) => Boolean(value) && value !== "none";
  return (
    set(style.transform) ||
    set(style.perspective) ||
    set(style.filter) ||
    /(paint|layout|strict|content)/.test(style.contain ?? "") ||
    /(transform|perspective|filter)/.test(style.willChange ?? "")
  );
}

function establishesContainingBlock(
  style: CSSStyleDeclaration,
  mode: "absolute" | "fixed",
): boolean {
  if (mode === "fixed") {
    // fixed 的 containing block 是视口；只有 transform 类祖先会把它拉回祖先盒子。
    return hasTransformLikeStyle(style);
  }
  return style.position !== "static" || hasTransformLikeStyle(style);
}

/**
 * 目标是否被某个 overflow 祖先完全裁剪。
 *
 * 只与祖先的 client rect 求交：部分可见仍算可见（标签照常给、可点击），
 * 完全落在裁剪区外的不给标签——命令中心 `CommandList` 的滚动裁剪会把
 * 折叠区外的 option 算成可跳转目标，标签悬在 footer 上但用户看不到目标
 * （Q2-19）。同一判据覆盖文件树等所有 overflow 容器。
 *
 * 但 CSS 里“祖先 overflow 裁剪”对脱文档流后代有例外：absolute/fixed 元素
 * 在到达自己的 containing block 之前不被上层的 overflow 裁剪（composer 的
 * 绝对定位底栏就能显示在 `v4-timeline` 滚动区底部之外；全宽侧栏是 fixed
 * host）。因此遍历时对 escaped 的后代跳过这些祖先，直到遇到其 containing
 * block（或对 fixed 而言的 transform 类祖先）。
 */
function isClippedOutByOverflowAncestor(element: Element, rect: DOMRect): boolean {
  const elementPosition = window.getComputedStyle(element).position;
  let escape: "absolute" | "fixed" | null =
    elementPosition === "absolute" ? "absolute" : elementPosition === "fixed" ? "fixed" : null;
  let ancestor = element.parentElement;
  while (ancestor && ancestor !== document.body && ancestor !== document.documentElement) {
    const style = window.getComputedStyle(ancestor);
    if (escape) {
      if (!establishesContainingBlock(style, escape)) {
        ancestor = ancestor.parentElement;
        continue;
      }
      // 到达 containing block：从这里开始 overflow 重新生效。
      escape = null;
    }
    const clipX = CLIPPING_OVERFLOW.test(style.overflowX);
    const clipY = CLIPPING_OVERFLOW.test(style.overflowY);
    if (clipX || clipY) {
      const ancestorRect = ancestor.getBoundingClientRect();
      // 无布局盒（display: contents 等）不构成裁剪区域。
      if (ancestorRect.width > 0 && ancestorRect.height > 0) {
        const outsideX =
          clipX && (rect.right <= ancestorRect.left || rect.left >= ancestorRect.right);
        const outsideY =
          clipY && (rect.bottom <= ancestorRect.top || rect.top >= ancestorRect.bottom);
        if (outsideX || outsideY) {
          return true;
        }
      }
    }
    // 该祖先自身若脱离文档流，它也会逃逸更上层的 overflow。
    if (style.position === "fixed") {
      escape = "fixed";
    } else if (style.position === "absolute") {
      escape = "absolute";
    }
    ancestor = ancestor.parentElement;
  }
  return false;
}

function isHintCandidate(element: Element): boolean {
  if (!isVisible(element)) {
    return false;
  }
  if (element.closest("[data-vim-hint-overlay]")) {
    return false;
  }
  if (element.hasAttribute("disabled") || element.getAttribute("aria-disabled") === "true") {
    return false;
  }
  if (element.closest('[aria-hidden="true"]')) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (!intersectsViewport(rect)) {
    return false;
  }
  // 视口内 ≠ 用户看得见：列表/滚动容器会把渲染出来但滚出裁剪区的项藏掉。
  return !isClippedOutByOverflowAncestor(element, rect);
}

function encodeLabel(index: number, length: number): string {
  let remaining = index;
  let label = "";
  for (let position = 0; position < length; position += 1) {
    label = HINT_LABEL_CHARS[remaining % HINT_LABEL_CHARS.length]! + label;
    remaining = Math.floor(remaining / HINT_LABEL_CHARS.length);
  }
  return label;
}

/** 收集当前视口内所有可交互目标并分配 easymotion 标签。 */
export function collectHintTargets(root: ParentNode = document): HintTarget[] {
  const elements = Array.from(root.querySelectorAll<Element>(CLICKABLE_SELECTOR))
    .filter(isHintCandidate)
    .slice(0, MAX_HINT_TARGETS);
  const labelLength = elements.length <= HINT_LABEL_CHARS.length ? 1 : 2;
  return elements.map((element, index) => ({
    label: encodeLabel(index, labelLength),
    element,
    rect: element.getBoundingClientRect(),
  }));
}

/**
 * 补一条真实指针序列：Radix 的 DropdownMenu/Select 触发器在 pointerdown 打开，
 * 合成 click 不经过它们的打开路径（只聚焦、不展开）。pointerId 固定为非触屏
 * mouse，让 Select 的 pointerTypeRef 走 “mouse” 分支；后续 click 不再重复开关。
 */
function dispatchPointer(element: Element, type: "pointerdown" | "pointerup"): void {
  const rect = element.getBoundingClientRect();
  const init: PointerEventInit = {
    bubbles: true,
    cancelable: true,
    composed: true,
    pointerId: 1,
    pointerType: "mouse",
    isPrimary: true,
    button: 0,
    buttons: type === "pointerdown" ? 1 : 0,
    clientX: rect.left + rect.width / 2,
    clientY: rect.top + rect.height / 2,
  };
  const event =
    typeof PointerEvent === "function"
      ? new PointerEvent(type, init)
      : new MouseEvent(type, init as MouseEventInit);
  element.dispatchEvent(event);
}

/**
 * 激活提示目标：焦点 + 指针序列 + click。
 *
 * - 普通按钮：pointerdown/up 无人监听，click 的 onClick 触发一次；
 * - Radix DropdownMenu 触发器：pointerdown 打开，click 无 onClick，不会二次开关；
 * - Radix Select 触发器/选项：pointerdown 记录 pointerType=mouse，pointerup
 *   完成选择，随后 click 因 pointerType 不再是 “mouse” 而跳过，只触发一次；
 * - SVGElement（recharts accessibilityLayer 的 `svg[role=application]`）没有
 *   `click()`（那是 HTMLElement 专属）：改用合成 MouseEvent，仍走冒泡与
 *   React 事件委托；所有步骤对“方法不存在/不可聚焦”容错，不抛异常。
 */
export function activateTarget(element: Element): void {
  try {
    element.scrollIntoView({ block: "nearest", inline: "nearest" });
  } catch {
    // 非布局环境没有 scrollIntoView：不影响激活本身。
  }
  const focus = (element as Element & { focus?: (options?: FocusOptions) => void }).focus;
  if (typeof focus === "function") {
    try {
      focus.call(element, { preventScroll: true });
    } catch {
      // 非可聚焦元素（部分 li/div）忽略焦点错误，直接点。
    }
  }
  const click = (element as Element & { click?: () => void }).click;
  if (typeof click === "function") {
    dispatchPointer(element, "pointerdown");
    dispatchPointer(element, "pointerup");
    click.call(element);
    return;
  }
  element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
}

function closestClickable(element: Element | null): Element | null {
  if (!element) {
    return null;
  }
  return element.closest(CLICKABLE_SELECTOR);
}

/** 在可见页面（或指定根，如打开的对话框）内查找双字符文本命中（sneak）。 */
export function findSneakMatches(query: string, scope?: ParentNode): SneakMatch[] {
  if (query.length === 0) {
    return [];
  }
  const root = scope ?? document.body;
  const lowerQuery = query.toLowerCase();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const text = node.nodeValue;
      const parent = node.parentElement;
      if (!text || !text.trim() || !parent) {
        return NodeFilter.FILTER_REJECT;
      }
      if (
        parent.closest(
          "script, style, textarea, [aria-hidden='true'], [inert], [data-vim-hint-overlay], [data-testid='vim-mode-indicator']",
        )
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return isVisible(parent) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const matches: SneakMatch[] = [];
  let node = walker.nextNode();
  while (node && matches.length < MAX_SNEAK_MATCHES) {
    const text = node.nodeValue ?? "";
    const haystack = text.toLowerCase();
    let index = haystack.indexOf(lowerQuery);
    while (index >= 0 && matches.length < MAX_SNEAK_MATCHES) {
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + query.length);
      const rect = range.getBoundingClientRect();
      const container = node.parentElement;
      if (container && rect.width > 0 && rect.height > 0) {
        matches.push({ rect, container, element: closestClickable(container) });
      }
      index = haystack.indexOf(lowerQuery, index + 1);
    }
    node = walker.nextNode();
  }
  return matches;
}

/** 把命中滚到视口中间（虚拟列表靠 scrollIntoView 触发渲染窗口更新）。 */
export function scrollToSneakMatch(match: SneakMatch): void {
  match.container.scrollIntoView({ block: "center", inline: "nearest" });
}
