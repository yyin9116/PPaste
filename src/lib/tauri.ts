import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export interface BackendClip {
  id: string;
  clip_type: 'text' | 'image' | 'link' | 'file';
  category?: string;
  content: string;
  preview?: string;
  timestamp: number;
  source?: string;
}

export interface BackendSettings {
  theme: 'dark' | 'light' | string;
  language: 'zh' | 'en' | string;
  launch_at_login: boolean;
  play_sounds: boolean;
  history_retention_days: number;
  max_clips: number;
  ignore_password_managers: boolean;
  plain_text_only: boolean;
  storage_path?: string;
  screenshot_shortcut?: string;
  toggle_window_shortcut?: string;
}

export interface ClipStats {
  total_clips: number;
  total_size_bytes: number;
  total_size_mb: number;
  oldest_clip?: number | null;
  database_path: string;
}

export async function getClips(limit = 100, offset = 0): Promise<BackendClip[]> {
  return invoke<BackendClip[]>('get_clips', { limit, offset });
}

export async function deleteClip(id: string): Promise<void> {
  return invoke('delete_clip', { id });
}

export async function clearAllClips(): Promise<void> {
  return invoke('clear_all_clips');
}

export async function writeToClipboard(content: string, clipType: BackendClip['clip_type'] | string): Promise<void> {
  return invoke('write_to_clipboard', { content, clipType });
}

export async function pasteClip(content: string, clipType: BackendClip['clip_type'] | string): Promise<void> {
  return invoke('paste_clip', { content, clipType });
}

export async function getSettings(): Promise<BackendSettings> {
  return invoke<BackendSettings>('get_settings');
}

export async function updateSettings(settings: BackendSettings): Promise<void> {
  return invoke('update_settings', { settings });
}

export async function updateShortcut(shortcutType: 'screenshot' | 'toggle_window', shortcut: string): Promise<void> {
  return invoke('update_shortcut', { shortcutType, shortcut });
}

export async function setRunAtLogin(enabled: boolean): Promise<void> {
  return invoke('set_run_at_login', { enabled });
}

export async function togglePause(): Promise<boolean> {
  return invoke<boolean>('toggle_pause');
}

export async function hideWindow(): Promise<void> {
  return invoke('hide_window');
}

export async function showWindow(): Promise<void> {
  return invoke('show_window');
}

export async function getStats(): Promise<ClipStats> {
  return invoke<ClipStats>('get_stats');
}

export async function listenToNewClip(callback: (clip: BackendClip) => void) {
  return listen<BackendClip>('new-clip', (event) => {
    callback(event.payload);
  });
}
