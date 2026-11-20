/**
 * Vim 提示/搜索浮层的显示状态（hint = easymotion 标签，sneak = 双字符命中）。
 * 独立于 vimStore：浮层随会话开关瞬时变化，不持久化、不影响 NORMAL/INSERT 徽标。
 */
import { useSyncExternalStore } from "react";

export interface VimHintBadge {
  label: string;
  left: number;
  top: number;
  width: number;
  height: number;
}

export type VimOverlayState =
  | { kind: "hints"; buffer: string; badges: VimHintBadge[] }
  | { kind: "sneak"; query: string; badges: VimHintBadge[]; activeIndex: number }
  | { kind: "message"; messageId: string }
  | null;

let overlay: VimOverlayState = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) {
    listener();
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getVimOverlay(): VimOverlayState {
  return overlay;
}

export function setVimOverlay(next: VimOverlayState): void {
  overlay = next;
  emit();
}

export function useVimOverlay(): VimOverlayState {
  return useSyncExternalStore(subscribe, getVimOverlay, () => null);
}
