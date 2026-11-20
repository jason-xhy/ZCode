/**
 * easymotion 标签的落点计算（纯函数，便于单测）。
 *
 * 设计目标：标签只贴在目标元素框外，不覆盖元素本身的文字/图标——
 * 早期版本把标签居中压在元素上，任务行/按钮的文案被挡住，等于看不到要跳的位置。
 * 优先放在元素上方（左侧对齐），顶部放不下时放下方；只有上下都放不下
 * （接近满视口高度的元素）才退到元素内左上角。
 */

export interface VimHintAnchor {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface VimHintBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export const VIM_HINT_BADGE_HEIGHT = 14;
export const VIM_HINT_BADGE_GAP = 1;
/** 10px 等宽字体下单字符宽度按 7px 估算，加上左右 padding。 */
const HINT_LABEL_CHAR_WIDTH = 7;
const HINT_LABEL_PADDING = 8;

export function placeHintBadge(
  label: string,
  anchor: VimHintAnchor,
  viewport: { width: number; height: number },
): VimHintBox {
  const width = Math.max(14, label.length * HINT_LABEL_CHAR_WIDTH + HINT_LABEL_PADDING);
  let top = anchor.top - VIM_HINT_BADGE_HEIGHT - VIM_HINT_BADGE_GAP;
  if (top < 0) {
    // 顶部没有空间（标题栏/工具栏）：落到元素下方，仍在元素框外。
    top = anchor.top + anchor.height + VIM_HINT_BADGE_GAP;
  }
  if (viewport.height > 0 && top + VIM_HINT_BADGE_HEIGHT > viewport.height) {
    // 上下都放不下（超高元素）：退到元素内左上角，至少保持在同一列。
    top = Math.max(0, anchor.top + VIM_HINT_BADGE_GAP);
  }
  const maxLeft = Math.max(0, viewport.width - width);
  const left = Math.min(Math.max(0, anchor.left), maxLeft);
  return { left, top, width, height: VIM_HINT_BADGE_HEIGHT };
}
