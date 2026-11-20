/**
 * Vim 导航状态指示器 + 键位帮助浮层。
 *
 * - 常驻右下角的 NORMAL / INSERT 徽标解决「不知道自己现在在哪个模式」的问题：
 *   模式不是开关状态，而是随焦点是否在输入框变化；
 * - 帮助浮层只读展示键位表，开关/关闭都走 vimStore，不持有本地状态。
 */
import { createPortal } from "react-dom";
import { Kbd } from "@/components/ui/kbd.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { setVimHelpOpen, useVimHelpOpen } from "@/vim/vimStore.js";
import { useVimMode } from "@/vim/useVimNavigation.js";
import { VimHintOverlay } from "@/vim/VimHintOverlay.js";

interface VimHelpRow {
  keys: string;
  descriptionId: string;
}

const VIM_HELP_ROWS: readonly VimHelpRow[] = [
  { keys: "j / k", descriptionId: "vim.help.move" },
  { keys: "d / u · Ctrl+d / Ctrl+u", descriptionId: "vim.help.halfPage" },
  { keys: "gg / G", descriptionId: "vim.help.edge" },
  { keys: "h / l", descriptionId: "vim.help.region" },
  { keys: "i / a", descriptionId: "vim.help.insert" },
  { keys: "Ctrl+[ / Esc", descriptionId: "vim.help.exit" },
  { keys: "Ctrl+Alt+Esc", descriptionId: "vim.help.leavePane" },
  { keys: "f", descriptionId: "vim.help.hint" },
  { keys: "s", descriptionId: "vim.help.sneak" },
  { keys: ":", descriptionId: "vim.help.commandCenter" },
  { keys: "/", descriptionId: "vim.help.find" },
  { keys: "[ / ]", descriptionId: "vim.help.conversation" },
  { keys: "b", descriptionId: "vim.help.sidebar" },
  { keys: "t", descriptionId: "vim.help.terminal" },
  { keys: "?", descriptionId: "vim.help.help" },
];

export function VimModeIndicator() {
  const { intl } = useZCodeIntl();
  const mode = useVimMode();
  const helpOpen = useVimHelpOpen();

  if (mode === "off") {
    return null;
  }

  return createPortal(
    <>
      <div
        data-testid="vim-mode-indicator"
        className="pointer-events-none fixed bottom-3 right-3 z-[80] flex items-center gap-2 rounded-lg border border-popover-border bg-popover px-2 py-1 text-ui-sm text-foreground shadow-md"
      >
        <span
          className={
            mode === "insert"
              ? "rounded-md px-1.5 py-0.5 font-medium text-foreground-subtle"
              : "rounded-md bg-primary px-1.5 py-0.5 font-medium text-primary-foreground"
          }
        >
          {intl.formatMessage({
            id: mode === "insert" ? "vim.indicator.insert" : "vim.indicator.normal",
          })}
        </span>
        <Kbd className="text-foreground-subtlest">?</Kbd>
      </div>
      {helpOpen ? (
        <div
          data-testid="vim-help"
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/60 p-4"
          onClick={() => setVimHelpOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={intl.formatMessage({ id: "vim.help.title" })}
            className="max-h-[80vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-popover-border bg-popover p-6 text-ui-base/relaxed text-foreground shadow-xl [app-region:no-drag]"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <h2 className="text-ui-lg font-semibold">
                {intl.formatMessage({ id: "vim.help.title" })}
              </h2>
              <span className="text-ui-sm text-foreground-subtle">
                {intl.formatMessage({ id: "vim.help.closeHint" })}
              </span>
            </div>
            <p className="mb-4 text-ui-sm text-foreground-subtle">
              {intl.formatMessage({ id: "vim.help.subtitle" })}
            </p>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-ui-sm">
              {VIM_HELP_ROWS.map((row) => (
                <div key={row.descriptionId} className="contents">
                  <dt>
                    <Kbd className="whitespace-nowrap">{row.keys}</Kbd>
                  </dt>
                  <dd className="text-foreground-subtle">
                    {intl.formatMessage({ id: row.descriptionId })}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      ) : null}
      <VimHintOverlay />
    </>,
    document.body,
  );
}
