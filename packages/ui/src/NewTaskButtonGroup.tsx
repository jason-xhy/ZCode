import { MessageCirclePlus } from "lucide-react";
import { TID_TASK_NEW_BUTTON } from "@zcode/shared/test-ids";
import { cn } from "@/components/lib/utils.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useShortcutCommandLabel } from "@/shortcuts/useShortcutBindings.js";
import { runUserAction } from "@/lib/userActionTelemetry.js";

export function NewTaskButtonGroup({
  onCreateTask,
  disabled = false,
}: {
  onCreateTask: () => void;
  disabled?: boolean;
}) {
  const { intl } = useZCodeIntl();
  const newTaskShortcutLabel = useShortcutCommandLabel("newTask");
  const handleActivate = () => {
    if (disabled) {
      return;
    }
    runUserAction({
      input: { featureId: "task.lifecycle", action: "create", trigger: "button" },
      operation: onCreateTask,
      completed: { resultSource: "optimistic_projection" },
      failureStage: "task_create",
    });
  };
  return (
    <div
      // 语义上是按钮：用 div 只为沿用整行布局。没有 role/tabIndex 时 Tab
      // 永远轮不到它，f 提示也把它当普通容器漏掉（Q1-01）。
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      data-testid={TID_TASK_NEW_BUTTON}
      onClick={handleActivate}
      onKeyDown={(event) => {
        // 非原生 button 没有 Enter/Space 的隐式激活；手动触发并 preventDefault
        // （同时阻止 Space 滚动页面），不会产生第二次 click。
        if (event.key !== "Enter" && event.key !== " ") {
          return;
        }
        event.preventDefault();
        handleActivate();
      }}
      className={cn(
        "group w-full h-8 rounded-lg inline-flex shrink-0 items-center justify-stretch gap-2 overflow-hidden pl-2.5 pr-2.5 hover:bg-surface-hover hover:text-foreground active:translate-y-0 cursor-pointer",
        disabled &&
          "cursor-not-allowed text-foreground-subtlest hover:bg-transparent hover:text-foreground-subtlest",
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-2 text-ui-base">
        <MessageCirclePlus className="h-4 w-4 shrink-0" />
        <span className="truncate">{intl.formatMessage({ id: "taskList.newThread" })}</span>
        <span className="ml-auto shrink-0 text-ui-xs font-normal text-foreground-subtlest">
          {newTaskShortcutLabel}
        </span>
      </div>
    </div>
  );
}
