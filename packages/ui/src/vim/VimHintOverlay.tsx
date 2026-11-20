/**
 * Vim 提示/搜索浮层（easymotion 标签 / sneak 命中框）。
 * 纯展示层：位置来自 getBoundingClientRect，pointer-events-none 不抢任何鼠标事件。
 * 视觉复用桌面端语义 token：popover 表面、primary 标签、find-highlight 命中框。
 */
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { placeHintBadge } from "@/vim/vimHintLayout.js";
import { useVimOverlay } from "@/vim/vimOverlayStore.js";

const SESSION_CHIP =
  "absolute left-1/2 top-3 -translate-x-1/2 rounded-lg border border-popover-border bg-popover px-3 py-1.5 text-ui-sm text-foreground shadow-md";

export function VimHintOverlay() {
  const { intl } = useZCodeIntl();
  const overlay = useVimOverlay();
  if (!overlay) {
    return null;
  }

  if (overlay.kind === "message") {
    // 无目标反馈：f 在当前作用域没有可打标签的控件时不能静默失败。
    return (
      <div data-vim-hint-overlay className="pointer-events-none fixed inset-0 z-[95]">
        <div className={SESSION_CHIP}>{intl.formatMessage({ id: overlay.messageId })}</div>
      </div>
    );
  }

  if (overlay.kind === "hints") {
    const badges = overlay.buffer
      ? overlay.badges.filter((badge) => badge.label.startsWith(overlay.buffer))
      : overlay.badges;
    return (
      <div data-vim-hint-overlay className="pointer-events-none fixed inset-0 z-[95]">
        <div className="absolute inset-0 bg-black/30" />
        {badges.map((badge) => {
          const box = placeHintBadge(badge.label, badge, {
            width: typeof window === "undefined" ? 0 : window.innerWidth,
            height: typeof window === "undefined" ? 0 : window.innerHeight,
          });
          return (
            <div key={`${badge.label}:${badge.left}:${badge.top}`}>
              {/* 目标框线只描边、不遮字：标签在框外时仍能一眼看出它对应哪个元素。 */}
              <div
                data-vim-hint-target
                style={{
                  left: badge.left - 1,
                  top: badge.top - 1,
                  width: badge.width + 2,
                  height: badge.height + 2,
                }}
                className="absolute rounded-md border border-primary"
              />
              <span
                data-vim-hint-label
                style={{ left: box.left, top: box.top, height: box.height }}
                className="absolute rounded-md bg-primary px-1 font-mono text-ui-xs font-semibold leading-[14px] text-primary-foreground shadow-md"
              >
                {badge.label}
              </span>
            </div>
          );
        })}
        <div className={SESSION_CHIP}>
          easymotion {overlay.buffer || "_"} · {intl.formatMessage({ id: "vim.overlay.cancel" })}
        </div>
      </div>
    );
  }

  return (
    <div data-vim-hint-overlay className="pointer-events-none fixed inset-0 z-[95]">
      {overlay.badges.map((badge, index) => (
        <div
          key={`${badge.left}:${badge.top}:${index}`}
          data-vim-sneak-match
          data-active={index === overlay.activeIndex ? "true" : undefined}
          style={{
            left: badge.left - 2,
            top: badge.top - 2,
            width: badge.width + 4,
            height: badge.height + 4,
          }}
          className={
            index === overlay.activeIndex
              ? "absolute rounded-md border-2 border-primary bg-selected"
              : "absolute rounded-md border border-border-hover bg-transparent"
          }
        />
      ))}
      <div className={SESSION_CHIP}>
        sneak {overlay.query} ·{" "}
        {overlay.badges.length > 0
          ? `${overlay.activeIndex + 1}/${overlay.badges.length} · ${intl.formatMessage({ id: "vim.overlay.sneakCycle" })}`
          : overlay.query.length >= 2
            ? intl.formatMessage({ id: "vim.overlay.sneakNoMatch" })
            : intl.formatMessage({ id: "vim.overlay.sneakType" })}
      </div>
    </div>
  );
}
