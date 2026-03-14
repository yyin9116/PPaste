import { memo, startTransition, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  AlertTriangle,
  Camera,
  Check,
  ChevronDown,
  Clock,
  Code,
  Copy,
  FileText,
  Image as ImageIcon,
  Keyboard,
  Link as LinkIcon,
  Maximize2,
  Monitor,
  Pin,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import {
  clearAllClips,
  deleteClip,
  exportClipsJson,
  getClips,
  getRunAtLogin,
  getSettings,
  hideWindow,
  importClipsJson,
  listenToNewClip,
  pasteClip,
  revealPath,
  setRunAtLogin,
  takeScreenshot,
  updateSettings,
  updateShortcut,
  writeToClipboard,
  type BackendClip,
  type BackendClipEvent,
  type BackendSettings,
} from '../lib/tauri';

type ThemeMode = 'dark' | 'light';
type ThemePreference = ThemeMode | 'system';
type Language = 'en' | 'zh';
type ActiveCategory = 'all' | 'notes' | 'code' | 'links' | 'images' | 'files';

type SelectOption = {
  label: string;
  value: string;
};

interface ClipView {
  id: string;
  type: BackendClip['clip_type'];
  category?: string;
  resolvedCategory: string;
  content: string;
  preview?: string;
  timestamp: number;
  source?: string;
  isPinned: boolean;
}

function normalizeSource(source?: string) {
  if (!source) return undefined;
  const trimmed = source.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') return undefined;
  return trimmed;
}

function normalizePathLikeContent(content: string) {
  const trimmed = content.trim();
  if (/^(\/|~\/|[A-Za-z]:\\).+/.test(trimmed) && !trimmed.includes('\n')) {
    return trimmed;
  }
  return null;
}

const RECENT_QUERIES_STORAGE_KEY = 'ppaste:recent-queries';
const PINNED_CLIPS_STORAGE_KEY = 'ppaste:pinned-clips';

function getStoredStringArray(key: string) {
  if (typeof window === 'undefined') return [];

  try {
    const raw = localStorage.getItem(key);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function inferDetailedCategory(content: string, type: BackendClip['clip_type']) {
  if (type === 'image') return 'Images';
  if (type === 'file') return 'Files';

  const trimmed = content.trim();
  const lower = trimmed.toLowerCase();
  const lines = trimmed.split('\n').filter((line) => line.trim().length > 0);

  if (/^https?:\/\//.test(trimmed)) return 'Links';
  if (normalizePathLikeContent(trimmed)) return 'Files';

  if (
    (trimmed.startsWith('{') || trimmed.startsWith('[')) &&
    (() => {
      try {
        JSON.parse(trimmed);
        return true;
      } catch {
        return false;
      }
    })()
  ) {
    return 'JSON';
  }

  if (lower.includes('<!doctype html') || /<\/?[a-z][\s\S]*>/i.test(trimmed)) {
    return 'HTML';
  }

  if (
    lower.startsWith('<?xml') ||
    lower.includes('<rss') ||
    lower.includes('<feed') ||
    lower.includes('<rdf:rdf')
  ) {
    return 'Markup';
  }

  if (
    trimmed.includes('```') ||
    /^\s{0,3}(#{1,6}\s|\* |- |\d+\. |> )/m.test(trimmed) ||
    /\[[^\]]+\]\([^)]+\)/.test(trimmed)
  ) {
    return 'Markdown';
  }

  if (
    lines.length > 1 &&
    lines.every((line) => /^[\w"'`.-]+\s*:\s*.+$/.test(line.trim()))
  ) {
    return 'YAML';
  }

  if (/\b(select|insert into|update|delete from|create table|alter table|where)\b/i.test(trimmed)) {
    return 'SQL';
  }

  if (
    trimmed.startsWith('#!/bin/') ||
    /^\$\s+\S+/m.test(trimmed) ||
    /\b(export|sudo|cd|ls|mkdir|rm|cp|mv)\b/.test(lower)
  ) {
    return 'Shell';
  }

  if (/\b(fn|function|const|let|import|return|class|interface|type)\b/.test(trimmed) || trimmed.includes('=>')) {
    return 'Code';
  }

  if (lines.length > 1 && lines.every((line) => /^[-*•]\s+.+$/.test(line.trim()))) {
    return 'List';
  }

  if (lines.length > 2 && lines.every((line) => line.length < 120)) {
    return 'Notes';
  }

  return 'Notes';
}

function resolveClipCategory(clip: BackendClip) {
  if (clip.category === 'Images' || clip.category === 'Files' || clip.category === 'Links') return clip.category;
  if (clip.category === 'Text') return inferDetailedCategory(clip.content, clip.clip_type);
  if (clip.category === 'Notes') return inferDetailedCategory(clip.content, clip.clip_type);
  return inferDetailedCategory(clip.content, clip.clip_type);
}

function mapClip(clip: BackendClip, pinnedClipIds: string[], autoPinnedClipId: string | null): ClipView {
  return {
    id: clip.id,
    type: clip.clip_type,
    category: clip.category,
    resolvedCategory: resolveClipCategory(clip),
    content: clip.content,
    preview:
      clip.clip_type === 'image' && clip.content && !clip.content.startsWith('data:')
        ? `data:image/png;base64,${clip.content}`
        : clip.preview,
    timestamp: clip.timestamp,
    source: normalizeSource(clip.source),
    isPinned: pinnedClipIds.includes(clip.id) || autoPinnedClipId === clip.id,
  };
}

function getCategoryBucket(clip: ClipView): Exclude<ActiveCategory, 'all'> {
  if (clip.type === 'image' || clip.resolvedCategory === 'Images') return 'images';
  if (clip.type === 'file' || clip.resolvedCategory === 'Files') return 'files';
  if (clip.type === 'link' || clip.resolvedCategory === 'Links') return 'links';
  if (['Code', 'JSON', 'HTML', 'Markdown', 'YAML', 'SQL', 'Shell', 'Markup'].includes(clip.resolvedCategory)) return 'code';
  return 'notes';
}

function sortClips(clips: ClipView[]) {
  return [...clips].sort((a, b) => {
    if (a.isPinned !== b.isPinned) return a.isPinned ? -1 : 1;
    return b.timestamp - a.timestamp;
  });
}

function formatRelativeTime(timestamp: number, language: Language) {
  const rtf = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const diff = timestamp - Date.now();
  const mins = Math.round(diff / (1000 * 60));
  const hours = Math.round(diff / (1000 * 60 * 60));
  const days = Math.round(diff / (1000 * 60 * 60 * 24));

  if (Math.abs(mins) < 60) return rtf.format(mins, 'minute');
  if (Math.abs(hours) < 24) return rtf.format(hours, 'hour');
  return rtf.format(days, 'day');
}

function shortcutToDisplay(shortcut: string) {
  return shortcut
    .replace(/CmdOrCtrl/g, '⌘')
    .replace(/CommandOrControl/g, '⌘')
    .replace(/Meta/g, '⌘')
    .replace(/Alt/g, '⌥')
    .replace(/Shift/g, '⇧')
    .replace(/Ctrl/g, '⌃')
    .replace(/Plus/g, '+');
}

function categoryBadge(clip: ClipView, language: Language) {
  const labels: Record<string, { en: string; zh: string }> = {
    Notes: { en: 'Notes', zh: '笔记' },
    List: { en: 'List', zh: '列表' },
    Code: { en: 'Code', zh: '代码' },
    Links: { en: 'Links', zh: '链接' },
    Images: { en: '图片', zh: '图片' },
    Files: { en: '文件', zh: '文件' },
    Markdown: { en: 'Markdown', zh: 'Markdown' },
    Markup: { en: 'Markup', zh: '标记' },
    JSON: { en: 'JSON', zh: 'JSON' },
    HTML: { en: 'HTML', zh: 'HTML' },
    YAML: { en: 'YAML', zh: 'YAML' },
    SQL: { en: 'SQL', zh: 'SQL' },
    Shell: { en: 'Shell', zh: 'Shell' },
  };

  return labels[clip.resolvedCategory]?.[language] ?? clip.resolvedCategory;
}

function imageClipTitle(clip: ClipView, language: Language) {
  if (clip.source === 'Screenshot') {
    return language === 'zh' ? '截图' : 'Screenshot';
  }
  if (clip.source) {
    return language === 'zh' ? `${clip.source} 图片` : `${clip.source} image`;
  }
  return language === 'zh' ? '图片内容' : 'Image clip';
}

const TRANSLATIONS = {
  en: {
    searchPlaceholder: 'Search clipboard history...',
    noClips: 'No clips found for',
    navigate: 'Navigate',
    paste: 'Paste',
    copy: 'Copy',
    settings: 'Settings',
    close: 'Close',
    general: 'General',
    shortcuts: 'Shortcuts',
    advanced: 'Advanced',
    launchAtLogin: 'Launch at login',
    launchAtLoginDesc: 'Start PPaste automatically when you log in.',
    playSounds: 'Play sounds',
    playSoundsDesc: 'Play a subtle sound when copying or pasting.',
    showShortcutHints: 'Show shortcut hints',
    showShortcutHintsDesc: 'Display the footer hint bar at the bottom of the palette.',
    transparency: 'Transparency',
    transparencyDesc: 'Adjust the translucency of the palette and settings panel.',
    restoreDefaults: 'Restore Defaults',
    restoreDefaultsDesc: 'Reset appearance, toggles, and shortcuts back to the default values.',
    restoredDefaults: 'Defaults restored',
    language: 'Language',
    historyRetention: 'History Retention',
    keepHistoryFor: 'Keep history for',
    maxClips: 'Maximum clips',
    toggleClipboard: 'Toggle Clipboard',
    quickPaste: 'Quick Paste (Latest)',
    clearHistoryShortcut: 'Clear History',
    screenshotShortcut: 'Take Screenshot',
    shortcutHint: 'Click on a shortcut to record a new key combination.',
    ignorePasswordManagers: 'Ignore Password Managers',
    ignorePasswordManagersDesc: 'Do not record clips from 1Password, Bitwarden, etc.',
    plainTextOnly: 'Plain Text Only',
    plainTextOnlyDesc: 'Strip rich text formatting when copying.',
    dangerZone: 'Danger Zone',
    clearAllHistory: 'Clear All History',
    clearWarning: 'This action cannot be undone. All saved clips will be permanently deleted.',
    confirmClear: 'Are you sure you want to clear all history?',
    cancel: 'Cancel',
    confirm: 'Confirm',
    all: 'All',
    notes: 'Notes',
    code: 'Code',
    links: 'Links',
    images: 'Images',
    files: 'Files',
    days1: '1 Day',
    days7: '7 Days',
    days30: '30 Days',
    forever: 'Forever',
    unlimited: 'Unlimited',
    exportHistory: 'Export History',
    importHistory: 'Import History',
    exportDesc: 'Save your clipboard history to a JSON file.',
    importDesc: 'Restore your clipboard history from a JSON file.',
    copiedToClipboard: 'Copied to clipboard',
    pastedToApp: 'Pasted into active app',
    deleted: 'Clip deleted',
    failed: 'Action failed',
    dataManagement: 'Data Management',
    theme: 'Theme',
    system: 'System',
  dark: 'Dark',
    light: 'Light',
    recentSearches: 'Recent Searches',
    clearSearches: 'Clear',
    emptyStateMsg: 'Try a different keyword or category',
    preview: 'Quick Look',
    pin: 'Pin',
    unpin: 'Unpin',
    pinned: 'Pinned',
    unpinned: 'Unpinned',
    imported: 'History imported',
    exported: 'History exported',
    cleared: 'History cleared',
    screenshotCaptured: 'Screenshot saved to history',
    openInBrowser: 'Open in browser',
    linkPreviewUnavailable: 'This site blocks embedded preview. Open it in your browser.',
    revealInFinder: 'Reveal in Finder',
    pathPreview: 'Path preview',
    closeSettings: 'Close Settings',
  },
  zh: {
    searchPlaceholder: '搜索剪贴板历史...',
    noClips: '未找到相关内容',
    navigate: '导航',
    paste: '粘贴',
    copy: '复制',
    settings: '设置',
    close: '关闭',
    general: '常规',
    shortcuts: '快捷键',
    advanced: '高级',
    launchAtLogin: '开机启动',
    launchAtLoginDesc: '登录时自动启动 PPaste。',
    playSounds: '播放声音',
    playSoundsDesc: '复制或粘贴时播放提示音。',
    showShortcutHints: '显示操作提示',
    showShortcutHintsDesc: '在面板底部显示快捷键提示栏。',
    transparency: '透明度',
    transparencyDesc: '调节主面板和设置面板的透明程度。',
    restoreDefaults: '恢复默认',
    restoreDefaultsDesc: '将外观、开关和快捷键恢复为默认值。',
    restoredDefaults: '已恢复默认设置',
    language: '语言',
    historyRetention: '历史记录保留',
    keepHistoryFor: '保留历史记录',
    maxClips: '最大记录数',
    toggleClipboard: '唤起剪贴板',
    quickPaste: '快速粘贴 (最新)',
    clearHistoryShortcut: '清除历史记录',
    screenshotShortcut: '截图',
    shortcutHint: '点击快捷键以录制新的按键组合。',
    ignorePasswordManagers: '忽略密码管理器',
    ignorePasswordManagersDesc: '不记录来自 1Password、Bitwarden 等的内容。',
    plainTextOnly: '仅纯文本',
    plainTextOnlyDesc: '复制时去除富文本格式。',
    dangerZone: '危险区域',
    clearAllHistory: '清除所有历史记录',
    clearWarning: '此操作无法撤销。所有保存的剪贴板记录将被永久删除。',
    confirmClear: '确定要清除所有历史记录吗？',
    cancel: '取消',
    confirm: '确认',
    all: '全部',
    notes: '笔记',
    code: '代码',
    links: '链接',
    images: '图片',
    files: '文件',
    days1: '1 天',
    days7: '7 天',
    days30: '30 天',
    forever: '永久',
    unlimited: '无限制',
    exportHistory: '导出历史记录',
    importHistory: '导入历史记录',
    exportDesc: '将剪贴板历史记录保存为 JSON 文件。',
    importDesc: '从 JSON 文件恢复剪贴板历史记录。',
    copiedToClipboard: '已复制到剪贴板',
    pastedToApp: '已粘贴到当前应用',
    deleted: '已删除记录',
    failed: '操作失败，请重试',
    dataManagement: '数据管理',
    theme: '主题',
    system: '跟随系统',
    dark: '深色',
    light: '浅色',
    recentSearches: '最近搜索',
    clearSearches: '清除',
    emptyStateMsg: '尝试使用不同的关键字或分类',
    preview: '快速预览',
    pin: '置顶',
    unpin: '取消置顶',
    pinned: '已置顶',
    unpinned: '已取消置顶',
    imported: '已导入历史记录',
    exported: '已导出历史记录',
    cleared: '已清除历史记录',
    screenshotCaptured: '截图已保存到历史记录',
    openInBrowser: '在浏览器中打开',
    linkPreviewUnavailable: '该站点阻止内嵌预览，请在浏览器中打开。',
    revealInFinder: '在 Finder 中显示',
    pathPreview: '路径预览',
    closeSettings: '关闭设置',
  },
} as const;

function buildDefaultSettings(): BackendSettings {
  return {
    theme: 'system',
    language: 'zh',
    window_opacity: 0.92,
    launch_at_login: true,
    play_sounds: false,
    show_shortcut_hints: true,
    history_retention_days: 30,
    max_clips: 500,
    ignore_password_managers: true,
    plain_text_only: false,
    screenshot_shortcut: 'Alt+S',
    toggle_window_shortcut: 'Alt+Space',
    quick_paste_shortcut: 'CmdOrCtrl+Shift+V',
    clear_history_shortcut: 'CmdOrCtrl+Shift+Backspace',
  };
}

export default function DesktopEnvironment() {
  const [themePreference, setThemePreference] = useState<ThemePreference>('system');
  const [systemTheme, setSystemTheme] = useState<ThemeMode>('dark');
  const [language, setLanguage] = useState<Language>('zh');
  const [settingsData, setSettingsData] = useState<BackendSettings | null>(null);
  const [clips, setClips] = useState<ClipView[]>([]);
  const [recentQueries, setRecentQueries] = useState<string[]>(() => getStoredStringArray(RECENT_QUERIES_STORAGE_KEY));
  const [pinnedClipIds, setPinnedClipIds] = useState<string[]>(() => getStoredStringArray(PINNED_CLIPS_STORAGE_KEY));
  const [autoPinnedClipId, setAutoPinnedClipId] = useState<string | null>(null);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [toastVariant, setToastVariant] = useState<'success' | 'error'>('success');
  const [toastVisible, setToastVisible] = useState(false);
  const [focusedClipId, setFocusedClipId] = useState<string | null>(null);
  const opacityPersistTimeoutRef = useRef<number | null>(null);

  const t = TRANSLATIONS[language];
  const theme: ThemeMode = themePreference === 'system' ? systemTheme : themePreference;
  const panelOpacity = settingsData?.window_opacity ?? 0.92;

  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const updateTheme = () => setSystemTheme(media.matches ? 'dark' : 'light');
    updateTheme();
    media.addEventListener('change', updateTheme);
    return () => media.removeEventListener('change', updateTheme);
  }, []);

  const showToast = useCallback((message: string, variant: 'success' | 'error' = 'success') => {
    setToast(message);
    setToastVariant(variant);
    setToastVisible(true);

    window.setTimeout(() => {
      setToastVisible(false);
      window.setTimeout(() => setToast(null), 260);
    }, 2200);
  }, []);

  const closeSettings = useCallback(() => {
    setIsSettingsOpen(false);
  }, []);

  useEffect(() => {
    return () => {
      if (opacityPersistTimeoutRef.current !== null) {
        window.clearTimeout(opacityPersistTimeoutRef.current);
        opacityPersistTimeoutRef.current = null;
      }
    };
  }, []);

  const playFeedbackTone = useCallback(async () => {
    if (!settingsData?.play_sounds) return;

    const AudioContextCtor =
      window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;

    const context = new AudioContextCtor();
    if (context.state === 'suspended') {
      await context.resume();
    }

    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 920;
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.05, context.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.12);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.12);
    oscillator.onended = () => {
      void context.close();
    };
  }, [settingsData?.play_sounds]);

  const syncData = useCallback(async () => {
    const [clipRows, settingsRows, runAtLoginEnabled] = await Promise.all([getClips(500, 0), getSettings(), getRunAtLogin()]);
    const effectiveSettings = { ...settingsRows, launch_at_login: runAtLoginEnabled };
    setSettingsData(effectiveSettings);
    setThemePreference((effectiveSettings.theme as ThemePreference) || 'system');
    setLanguage((effectiveSettings.language as Language) || 'zh');
    startTransition(() => {
      setClips(sortClips(clipRows.map((clip) => mapClip(clip, pinnedClipIds, autoPinnedClipId))));
    });
  }, [autoPinnedClipId, pinnedClipIds]);

  useEffect(() => {
    void syncData();
    const interval = window.setInterval(() => void syncData(), 30000);
    const unlistenPromise = listenToNewClip((event: BackendClipEvent) => {
      const nextAutoPinnedClipId = event.auto_pin ? event.clip.id : event.clear_auto_pin ? null : autoPinnedClipId;
      if (event.auto_pin || event.clear_auto_pin) {
        setAutoPinnedClipId(nextAutoPinnedClipId);
      }
      if (event.clip.source === 'Screenshot') {
        setFocusedClipId(event.clip.id);
      }
      startTransition(() => {
        setClips((prev) =>
          sortClips([mapClip(event.clip, pinnedClipIds, nextAutoPinnedClipId), ...prev.filter((item) => item.id !== event.clip.id)]).slice(0, 500),
        );
      });
    });
    return () => {
      window.clearInterval(interval);
      void unlistenPromise.then((unlisten) => unlisten());
    };
  }, [autoPinnedClipId, pinnedClipIds, syncData]);

  useEffect(() => {
    localStorage.setItem(RECENT_QUERIES_STORAGE_KEY, JSON.stringify(recentQueries));
  }, [recentQueries]);

  useEffect(() => {
    localStorage.setItem(PINNED_CLIPS_STORAGE_KEY, JSON.stringify(pinnedClipIds));
    setClips((prev) => sortClips(prev.map((clip) => ({ ...clip, isPinned: pinnedClipIds.includes(clip.id) || autoPinnedClipId === clip.id }))));
  }, [autoPinnedClipId, pinnedClipIds]);

  const patchSettings = useCallback(
    async (next: Partial<BackendSettings>) => {
      if (!settingsData) return;
      const merged = { ...settingsData, ...next };
      setSettingsData(merged);
      if (next.theme) setThemePreference(next.theme as ThemePreference);
      if (next.language) setLanguage(next.language as Language);

      // 防止透明度快速拖动时被过期请求回写
      if (next.window_opacity !== undefined && Math.abs((settingsData.window_opacity ?? 0) - next.window_opacity) < 0.001) {
        return;
      }

      await updateSettings(merged);
    },
    [settingsData],
  );

  const saveShortcut = useCallback(
    async (shortcutType: 'screenshot' | 'toggle_window' | 'quick_paste' | 'clear_history', shortcut: string) => {
      await updateShortcut(shortcutType, shortcut);
      setSettingsData((prev) =>
        prev
          ? {
              ...prev,
              ...(shortcutType === 'screenshot' ? { screenshot_shortcut: shortcut } : {}),
              ...(shortcutType === 'toggle_window' ? { toggle_window_shortcut: shortcut } : {}),
              ...(shortcutType === 'quick_paste' ? { quick_paste_shortcut: shortcut } : {}),
              ...(shortcutType === 'clear_history' ? { clear_history_shortcut: shortcut } : {}),
            }
          : prev,
      );
    },
    [],
  );

  const handleClipAction = useCallback(
    async (clip: ClipView, mode: 'paste' | 'copy') => {
      try {
        if (mode === 'paste' && clip.type === 'text') {
          await pasteClip(clip.content, clip.type);
          await playFeedbackTone();
          showToast(t.pastedToApp);
          return;
        }

        await writeToClipboard(clip.content, clip.type);
        await playFeedbackTone();
        showToast(t.copiedToClipboard);
      } catch (error) {
        console.error(error);
        showToast(t.failed, 'error');
      }
    },
    [playFeedbackTone, showToast, t.copiedToClipboard, t.failed, t.pastedToApp],
  );

  const handleDeleteClip = useCallback(
    async (id: string) => {
      try {
        await deleteClip(id);
        setClips((prev) => prev.filter((clip) => clip.id !== id));
        setPinnedClipIds((prev) => prev.filter((clipId) => clipId !== id));
        if (autoPinnedClipId === id) setAutoPinnedClipId(null);
        showToast(t.deleted);
      } catch (error) {
        console.error(error);
        showToast(t.failed, 'error');
      }
    },
    [autoPinnedClipId, showToast, t.deleted, t.failed],
  );

  const handleTogglePinned = useCallback(
    (clipId: string) => {
      setPinnedClipIds((prev) => {
        const isPinned = prev.includes(clipId) || autoPinnedClipId === clipId;
        if (isPinned && autoPinnedClipId === clipId) {
          setAutoPinnedClipId(null);
        }
        showToast(isPinned ? t.unpinned : t.pinned);
        return prev.includes(clipId) ? prev.filter((id) => id !== clipId) : [clipId, ...prev];
      });
    },
    [autoPinnedClipId, showToast, t.pinned, t.unpinned],
  );

  const handleExportHistory = useCallback(async () => {
    try {
      const json = await exportClipsJson();
      const blob = new Blob([json], { type: 'application/json;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = 'ppaste-history.json';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      showToast(t.exported);
    } catch (error) {
      console.error(error);
      showToast(t.failed, 'error');
    }
  }, [showToast, t.exported, t.failed]);

  const handleImportHistory = useCallback(
    async (file: File | null) => {
      if (!file) return;
      try {
        const payload = await file.text();
        await importClipsJson(payload, true);
        await syncData();
        showToast(t.imported);
      } catch (error) {
        console.error(error);
        showToast(t.failed, 'error');
      }
    },
    [showToast, syncData, t.failed, t.imported],
  );

  const handleClearAll = useCallback(async () => {
    try {
      await clearAllClips();
      setClips([]);
      setPinnedClipIds([]);
      setAutoPinnedClipId(null);
      showToast(t.cleared);
    } catch (error) {
      console.error(error);
      showToast(t.failed, 'error');
    }
  }, [showToast, t.cleared, t.failed]);

  const handleTakeScreenshot = useCallback(async () => {
    try {
      await takeScreenshot();
      await syncData();
      await playFeedbackTone();
      showToast(t.screenshotCaptured);
    } catch (error) {
      console.error(error);
      showToast(t.failed, 'error');
    }
  }, [playFeedbackTone, showToast, syncData, t.failed, t.screenshotCaptured]);

  const handleRestoreDefaults = useCallback(async () => {
    const defaults = buildDefaultSettings();
    try {
      await Promise.all([
        setRunAtLogin(defaults.launch_at_login),
        updateShortcut('screenshot', defaults.screenshot_shortcut ?? 'Alt+S'),
        updateShortcut('toggle_window', defaults.toggle_window_shortcut ?? 'Alt+Space'),
        updateShortcut('quick_paste', defaults.quick_paste_shortcut ?? 'CmdOrCtrl+Shift+V'),
        updateShortcut('clear_history', defaults.clear_history_shortcut ?? 'CmdOrCtrl+Shift+Backspace'),
      ]);
      setThemePreference(defaults.theme as ThemePreference);
      setLanguage(defaults.language as Language);
      setSettingsData((prev) => ({ ...(prev ?? defaults), ...defaults }));
      await updateSettings({ ...(settingsData ?? defaults), ...defaults });
      showToast(t.restoredDefaults);
    } catch (error) {
      console.error(error);
      showToast(t.failed, 'error');
    }
  }, [settingsData, showToast, t.failed, t.restoredDefaults]);

  return (
    <div
      className={`relative h-screen w-full overflow-hidden font-sans selection:bg-neutral-800 ${
        theme === 'dark' ? 'bg-transparent text-neutral-200' : 'bg-transparent text-neutral-800'
      }`}
    >
      <AnimatePresence>
        {!isSettingsOpen && (
          <ClipboardPalette
            clips={clips}
            language={language}
            theme={theme}
            panelOpacity={panelOpacity}
            recentQueries={recentQueries}
            setRecentQueries={setRecentQueries}
            showShortcutHints={settingsData?.show_shortcut_hints !== false}
            focusedClipId={focusedClipId}
            onFocusedClipApplied={() => setFocusedClipId(null)}
            onClose={() => void hideWindow()}
            onOpenSettings={() => setIsSettingsOpen(true)}
            onTakeScreenshot={() => void handleTakeScreenshot()}
            onPasteClip={(clip) => void handleClipAction(clip, 'paste')}
            onCopyClip={(clip) => void handleClipAction(clip, 'copy')}
            onDeleteClip={(id) => void handleDeleteClip(id)}
            onTogglePinned={handleTogglePinned}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {isSettingsOpen && settingsData && (
          <SettingsModal
            settings={settingsData}
            language={language}
            theme={theme}
            panelOpacity={panelOpacity}
            onThemeChange={(value) => void patchSettings({ theme: value })}
            onLanguageChange={(value) => void patchSettings({ language: value })}
            onOpacityChange={(value) => {
              const next = Math.round(value * 100) / 100;
              setSettingsData((prev) => (prev ? { ...prev, window_opacity: next } : prev));

              if (opacityPersistTimeoutRef.current !== null) {
                window.clearTimeout(opacityPersistTimeoutRef.current);
              }
              opacityPersistTimeoutRef.current = window.setTimeout(() => {
                opacityPersistTimeoutRef.current = null;
                void patchSettings({ window_opacity: next });
              }, 80);
            }}
            onToggleLaunchAtLogin={async () => {
              const next = !settingsData.launch_at_login;
              await setRunAtLogin(next);
              await patchSettings({ launch_at_login: next });
            }}
            onTogglePlaySounds={() => void patchSettings({ play_sounds: !settingsData.play_sounds })}
            onToggleShortcutHints={() => void patchSettings({ show_shortcut_hints: !settingsData.show_shortcut_hints })}
            onRetentionChange={(value) => void patchSettings({ history_retention_days: Number(value) })}
            onMaxClipsChange={(value) => void patchSettings({ max_clips: Number(value) })}
            onToggleIgnorePasswordManagers={() =>
              void patchSettings({ ignore_password_managers: !settingsData.ignore_password_managers })
            }
            onTogglePlainTextOnly={() => void patchSettings({ plain_text_only: !settingsData.plain_text_only })}
            onSaveShortcut={(type, shortcut) => void saveShortcut(type, shortcut)}
            onExport={handleExportHistory}
            onImport={handleImportHistory}
            onRestoreDefaults={() => void handleRestoreDefaults()}
            onClearAll={() => void handleClearAll()}
            onClose={closeSettings}
          />
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && toastVisible && (
          <motion.div
            initial={{ opacity: 0, y: 18, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.96 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            className={`pointer-events-none absolute bottom-[calc(10vh+54px)] left-1/2 z-[95] flex max-w-[min(560px,calc(100%-40px))] -translate-x-1/2 items-center gap-2 rounded-xl border px-4 py-2 text-sm font-medium backdrop-blur-md ${
              toastVariant === 'error'
                ? 'border-red-500/25 bg-red-500/12 text-red-300'
                : 'border-teal-500/25 bg-teal-500/12 text-teal-300'
            }`}
          >
            {toastVariant === 'error' ? <AlertTriangle size={16} /> : <Check size={16} />}
            <span className="truncate">{toast}</span>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ClipboardPalette({
  clips,
  language,
  theme,
  panelOpacity,
  recentQueries,
  setRecentQueries,
  showShortcutHints,
  focusedClipId,
  onFocusedClipApplied,
  onClose,
  onOpenSettings,
  onTakeScreenshot,
  onPasteClip,
  onCopyClip,
  onDeleteClip,
  onTogglePinned,
}: {
  clips: ClipView[];
  language: Language;
  theme: ThemeMode;
  panelOpacity: number;
  recentQueries: string[];
  setRecentQueries: (next: string[] | ((prev: string[]) => string[])) => void;
  showShortcutHints: boolean;
  focusedClipId: string | null;
  onFocusedClipApplied: () => void;
  onClose: () => void;
  onOpenSettings: () => void;
  onTakeScreenshot: () => void;
  onPasteClip: (clip: ClipView) => void;
  onCopyClip: (clip: ClipView) => void;
  onDeleteClip: (id: string) => void;
  onTogglePinned: (id: string) => void;
}) {
  const t = TRANSLATIONS[language];
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [activeCategory, setActiveCategory] = useState<ActiveCategory>('all');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [quickLookItem, setQuickLookItem] = useState<ClipView | null>(null);
  const [keyboardNavigation, setKeyboardNavigation] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hoveredClipIdRef = useRef<string | null>(null);
  const closeQuickLook = useCallback(() => {
    setQuickLookItem(null);
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);
  const openQuickLook = useCallback((clip: ClipView) => {
    setQuickLookItem(clip);
  }, []);

  const filteredClips = useMemo(() => {
    return clips.filter((clip) => {
      const matchesQuery =
        clip.content.toLowerCase().includes(deferredQuery.toLowerCase()) || clip.source?.toLowerCase().includes(deferredQuery.toLowerCase());
      const matchesCategory = activeCategory === 'all' ? true : getCategoryBucket(clip) === activeCategory;
      return matchesQuery && matchesCategory;
    });
  }, [activeCategory, clips, deferredQuery]);

  const saveQuery = useCallback(
    (value: string) => {
      if (!value.trim()) return;
      setRecentQueries((prev) => [value.trim(), ...prev.filter((item) => item !== value.trim())].slice(0, 5));
    },
    [setRecentQueries],
  );

  const getActiveClip = useCallback(
    () => filteredClips.find((clip) => clip.id === hoveredClipIdRef.current) ?? filteredClips[selectedIndex],
    [filteredClips, selectedIndex],
  );

  useEffect(() => {
    setSelectedIndex(0);
    hoveredClipIdRef.current = null;
    setKeyboardNavigation(false);
  }, [activeCategory, query, showSuggestions]);

  useEffect(() => {
    const current = filteredClips[selectedIndex];
    if (!current) return;
    const node = document.querySelector<HTMLElement>(`[data-clip-id="${current.id}"]`);
    node?.scrollIntoView({ block: 'nearest' });
  }, [filteredClips, selectedIndex]);

  useEffect(() => {
    if (!focusedClipId) return;
    const nextIndex = filteredClips.findIndex((clip) => clip.id === focusedClipId);
    if (nextIndex >= 0) {
      setQuery('');
      setShowSuggestions(false);
      closeQuickLook();
      setActiveCategory('images');
      setSelectedIndex(nextIndex);
      onFocusedClipApplied();
      return;
    }

    const sourceIndex = clips.findIndex((clip) => clip.id === focusedClipId);
    if (sourceIndex >= 0) {
      setQuery('');
      setShowSuggestions(false);
      closeQuickLook();
      setActiveCategory('images');
      setSelectedIndex(0);
      onFocusedClipApplied();
    }
  }, [clips, closeQuickLook, filteredClips, focusedClipId, onFocusedClipApplied]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === ',') {
        event.preventDefault();
        onOpenSettings();
        return;
      }

      if (event.metaKey && event.key.toLowerCase() === 'c') {
        event.preventDefault();
        const selected = getActiveClip();
        if (selected) onCopyClip(selected);
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        hoveredClipIdRef.current = null;
        setKeyboardNavigation(true);
        setSelectedIndex((prev) => Math.min(prev + 1, (showSuggestions ? recentQueries : filteredClips).length - 1));
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        hoveredClipIdRef.current = null;
        setKeyboardNavigation(true);
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      } else if (event.key === 'Enter') {
        event.preventDefault();
        if (showSuggestions && recentQueries[selectedIndex]) {
          setQuery(recentQueries[selectedIndex]);
          setShowSuggestions(false);
          return;
        }

        const selected = getActiveClip();
        if (selected) {
          saveQuery(query);
          onPasteClip(selected);
        }
      } else if (event.code === 'Space' && (document.activeElement?.tagName !== 'INPUT' || query.trim().length === 0)) {
        event.preventDefault();
        if (quickLookItem) {
          closeQuickLook();
        } else {
          const selected = getActiveClip();
          if (selected) openQuickLook(selected);
        }
      } else if (event.key === 'Escape') {
        event.preventDefault();
        if (quickLookItem) {
          closeQuickLook();
        } else if (showSuggestions) {
          setShowSuggestions(false);
        } else {
          onClose();
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [closeQuickLook, getActiveClip, onClose, onCopyClip, onOpenSettings, onPasteClip, openQuickLook, query, quickLookItem, recentQueries, saveQuery, selectedIndex, showSuggestions]);

  const categories = [
    { id: 'all', label: t.all },
    { id: 'notes', label: t.notes },
    { id: 'code', label: t.code },
    { id: 'links', label: t.links },
    { id: 'images', label: t.images },
    { id: 'files', label: t.files },
  ] as const;

  return (
    <div className="absolute inset-0 z-40 flex items-start justify-center pt-[10vh]">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-transparent"
      />

      <motion.div
        initial={{ opacity: 0, y: -20, scale: 0.98 }}
        animate={{ opacity: panelOpacity, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: -10, scale: 0.98 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className={`relative flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-2xl ${
          theme === 'dark' ? 'border-white/10 bg-[#111111]' : 'border-black/10 bg-white'
        }`}
        style={{ height: '78vh', maxHeight: '78vh' }}
      >
        <div data-no-window-drag="true" className={`flex flex-col border-b ${theme === 'dark' ? 'border-white/5' : 'border-black/5'}`}>
          <div className="flex items-center px-4 py-4">
            <Search size={20} className="mr-3 text-neutral-500" />
            <input
              ref={searchInputRef}
              autoFocus
              type="text"
              placeholder={t.searchPlaceholder}
              value={query}
              onChange={(event) => {
                const value = event.target.value;
                setQuery(value);
                setShowSuggestions(value.length === 0 && recentQueries.length > 0);
              }}
              onFocus={() => {
                if (query.length === 0 && recentQueries.length > 0) setShowSuggestions(true);
              }}
              className={`flex-1 border-none bg-transparent text-lg font-light outline-none ${
                theme === 'dark' ? 'text-white placeholder:text-neutral-600' : 'text-black placeholder:text-neutral-400'
              }`}
            />
            <div className="flex items-center gap-2">
              <button
                onClick={onTakeScreenshot}
                className={`rounded-md p-1.5 transition-colors ${
                  theme === 'dark' ? 'text-neutral-500 hover:bg-white/10 hover:text-white' : 'text-neutral-400 hover:bg-black/5 hover:text-black'
                }`}
                title={t.screenshotShortcut}
              >
                <Camera size={16} />
              </button>
              <button
                onClick={onOpenSettings}
                className={`rounded-md p-1.5 transition-colors ${
                  theme === 'dark' ? 'text-neutral-500 hover:bg-white/10 hover:text-white' : 'text-neutral-400 hover:bg-black/5 hover:text-black'
                }`}
              >
                <Settings size={16} />
              </button>
            </div>
          </div>

          <div className="custom-scrollbar flex items-center gap-2 overflow-x-auto px-4 pb-3">
            {categories.map((category) => (
              <button
                key={category.id}
                onClick={() => setActiveCategory(category.id)}
                className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                  activeCategory === category.id
                    ? 'bg-indigo-500 text-white'
                    : theme === 'dark'
                      ? 'bg-white/5 text-neutral-400 hover:bg-white/10 hover:text-neutral-200'
                      : 'bg-black/5 text-neutral-600 hover:bg-black/10 hover:text-neutral-800'
                }`}
              >
                {category.label}
              </button>
            ))}
          </div>
        </div>

        <div
          data-no-window-drag="true" className="custom-scrollbar relative flex-1 overflow-y-auto px-2 pb-3 pt-3"
          onMouseLeave={() => {
            hoveredClipIdRef.current = null;
          }}
        >
          {showSuggestions ? (
            <div className="py-2">
              <div className="flex items-center justify-between px-3 py-1 text-xs font-medium text-neutral-500">
                <span>{t.recentSearches}</span>
                <button onClick={() => setRecentQueries([])} className="hover:text-neutral-400">
                  {t.clearSearches}
                </button>
              </div>
              {recentQueries.map((item, index) => (
                <button
                  key={item}
                  onClick={() => {
                    setQuery(item);
                    setShowSuggestions(false);
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`flex h-12 w-full items-center gap-3 rounded-xl px-3 py-2 text-left transition-colors ${
                    index === selectedIndex
                      ? theme === 'dark'
                        ? 'bg-white/10 text-white'
                        : 'bg-black/5 text-black'
                      : theme === 'dark'
                        ? 'text-neutral-400 hover:bg-white/5'
                        : 'text-neutral-600 hover:bg-black/5'
                  }`}
                >
                  <Clock size={14} className="opacity-50" />
                  <span className="text-sm font-medium">{item}</span>
                </button>
              ))}
            </div>
          ) : filteredClips.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 text-neutral-500">
              <motion.div
                initial={{ scale: 0.8, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', bounce: 0.5 }}
                className={`mb-6 flex h-24 w-24 items-center justify-center rounded-full ${
                  theme === 'dark' ? 'bg-neutral-800/50' : 'bg-neutral-200/50'
                }`}
              >
                <Search size={40} className={theme === 'dark' ? 'text-neutral-600' : 'text-neutral-400'} />
              </motion.div>
              <p className="text-sm font-medium">
                {t.noClips} {query ? `"${query}"` : ''}
              </p>
              <p className="mt-2 text-xs opacity-60">{t.emptyStateMsg}</p>
            </div>
          ) : (
            filteredClips.map((clip, index) => (
              <ClipItem
                key={clip.id}
                clip={clip}
                language={language}
                theme={theme}
                isSelected={keyboardNavigation && index === selectedIndex}
                onSelect={() => setSelectedIndex(index)}
                onHoverStart={() => {
                  hoveredClipIdRef.current = clip.id;
                  setKeyboardNavigation(false);
                }}
                onHoverEnd={() => {
                  if (hoveredClipIdRef.current === clip.id) hoveredClipIdRef.current = null;
                }}
                onPaste={() => {
                  saveQuery(query);
                  onPasteClip(clip);
                }}
                onPreview={() => openQuickLook(clip)}
                onCopy={() => onCopyClip(clip)}
                onDelete={() => onDeleteClip(clip.id)}
                onTogglePinned={() => onTogglePinned(clip.id)}
                previewLabel={t.preview}
                pinLabel={clip.isPinned ? t.unpin : t.pin}
              />
            ))
          )}
        </div>

        {showShortcutHints ? (
          <div
            data-no-window-drag="true" className={`flex items-center justify-between border-t px-4 py-2 text-[11px] font-medium ${
              theme === 'dark' ? 'border-white/5 bg-black/20 text-neutral-500' : 'border-black/5 bg-black/5 text-neutral-500'
            }`}
          >
            <div className="flex min-w-0 flex-wrap items-center gap-3">
              <ShortcutHint theme={theme} keys={['↑', '↓']} label={t.navigate} />
              <ShortcutHint theme={theme} keys={['↵']} label={t.paste} />
              <ShortcutHint theme={theme} keys={['⌘', 'C']} label={t.copy} />
              <ShortcutHint theme={theme} keys={['Space']} label={t.preview} />
            </div>
            <div className="ml-auto flex min-w-0 flex-wrap items-center gap-3">
              <ShortcutHint theme={theme} keys={['⌥', 'S']} label={t.screenshotShortcut} />
              <ShortcutHint theme={theme} keys={['⌘', ',']} label={t.settings} />
              <ShortcutHint theme={theme} keys={['esc']} label={t.close} />
            </div>
          </div>
        ) : null}

        <AnimatePresence>
          {quickLookItem ? <QuickLookItem clip={quickLookItem} language={language} theme={theme} onClose={closeQuickLook} /> : null}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}

const QuickLookItem = memo(function QuickLookItem({
  clip,
  language,
  theme,
  onClose,
}: {
  clip: ClipView;
  language: Language;
  theme: ThemeMode;
  onClose: () => void;
}) {
  const [linkPreviewFailed, setLinkPreviewFailed] = useState(false);
  const [pathActionError, setPathActionError] = useState<string | null>(null);
  const pathLikeContent = normalizePathLikeContent(clip.content);

  useEffect(() => {
    setLinkPreviewFailed(false);
    setPathActionError(null);
  }, [clip.id]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.14, ease: [0.16, 1, 0.3, 1] }}
      className="absolute inset-3 z-[120] flex items-center justify-center bg-transparent"
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.98, y: 8 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.98, y: 8 }}
        transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
        onClick={(event) => event.stopPropagation()}
        className={`flex h-full w-full max-w-full flex-col overflow-hidden rounded-2xl border shadow-2xl ${
          theme === 'dark' ? 'border-white/10 bg-[#1a1a1a]' : 'border-black/10 bg-neutral-50'
        }`}
      >
        <div
          className={`flex items-center justify-between border-b px-4 py-3 ${
            theme === 'dark' ? 'border-white/10 bg-white/5' : 'border-black/10 bg-black/5'
          }`}
        >
          <div className="flex items-center gap-2">
            {clip.type === 'image' ? (
              <ImageIcon size={16} className="text-indigo-500" />
            ) : clip.type === 'link' ? (
              <LinkIcon size={16} className="text-indigo-500" />
            ) : getCategoryBucket(clip) === 'code' ? (
              <Code size={16} className="text-indigo-500" />
            ) : (
              <FileText size={16} className="text-indigo-500" />
            )}
            <span className={`text-sm font-medium ${theme === 'dark' ? 'text-neutral-100' : 'text-neutral-900'}`}>{TRANSLATIONS[language].preview}</span>
          </div>
          <button
            onClick={onClose}
            className={`rounded-md p-1 transition-colors ${
              theme === 'dark' ? 'text-neutral-400 hover:bg-white/10 hover:text-white' : 'text-neutral-500 hover:bg-black/10 hover:text-black'
            }`}
          >
            <X size={16} />
          </button>
        </div>
        <div className="custom-scrollbar flex flex-1 items-center justify-center overflow-auto p-4">
          {clip.type === 'image' && clip.preview ? (
            <div className="relative h-full min-h-[220px] w-full">
              <img
                src={clip.preview}
                alt="Preview"
                className="h-full w-full rounded-lg object-contain"
                referrerPolicy="no-referrer"
                loading="eager"
                decoding="async"
              />
            </div>
          ) : clip.type === 'link' ? (
            <div className="flex h-full w-full min-h-[360px] flex-col gap-3">
              <div className="flex items-center justify-between gap-3">
                <div className="min-w-0">
                  <a href={clip.content} target="_blank" rel="noreferrer" className="block truncate text-sm font-medium text-indigo-500 hover:underline">
                    {clip.content}
                  </a>
                  {clip.source ? <p className="mt-1 text-xs text-neutral-500">{clip.source}</p> : null}
                </div>
                <a
                  href={clip.content}
                  target="_blank"
                  rel="noreferrer"
                  className={`inline-flex h-8 flex-shrink-0 items-center rounded-lg px-3 text-xs font-medium transition-colors ${
                    theme === 'dark' ? 'bg-white/5 text-neutral-200 hover:bg-white/10' : 'bg-black/5 text-neutral-800 hover:bg-black/10'
                  }`}
                >
                  {TRANSLATIONS[language].openInBrowser}
                </a>
              </div>
              <div
                className={`relative flex flex-1 overflow-hidden rounded-xl border ${
                  theme === 'dark' ? 'border-white/10 bg-black/40' : 'border-black/10 bg-white'
                }`}
              >
                {!linkPreviewFailed ? (
                  <iframe
                    src={clip.content}
                    title={clip.content}
                    className="h-full w-full bg-white"
                    sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
                    referrerPolicy="no-referrer"
                    onError={() => setLinkPreviewFailed(true)}
                  />
                ) : null}
                <div
                  className={`absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center ${
                    linkPreviewFailed ? 'pointer-events-auto' : 'pointer-events-none opacity-0'
                  } ${theme === 'dark' ? 'bg-[#1a1a1a]' : 'bg-neutral-50'}`}
                >
                  <div className={`flex h-14 w-14 items-center justify-center rounded-2xl ${theme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`}>
                    <LinkIcon size={28} className="text-indigo-500" />
                  </div>
                  <p className="max-w-md text-sm text-neutral-500">{TRANSLATIONS[language].linkPreviewUnavailable}</p>
                  <a
                    href={clip.content}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex h-9 items-center rounded-lg bg-indigo-500 px-4 text-sm font-medium text-white transition-colors hover:bg-indigo-600"
                  >
                    {TRANSLATIONS[language].openInBrowser}
                  </a>
                </div>
              </div>
            </div>
          ) : getCategoryBucket(clip) === 'files' && pathLikeContent ? (
            <div className="flex h-full w-full max-w-2xl flex-col items-center justify-center gap-4 text-center">
              <div className={`flex h-16 w-16 items-center justify-center rounded-2xl ${theme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`}>
                <FileText size={28} className="text-indigo-500" />
              </div>
              <div>
                <div className="text-sm font-medium">{TRANSLATIONS[language].pathPreview}</div>
                <div className="mt-2 break-all font-mono text-xs text-neutral-500">{pathLikeContent}</div>
              </div>
              <button
                type="button"
                onClick={async () => {
                  try {
                    setPathActionError(null);
                    await revealPath(pathLikeContent);
                  } catch (error) {
                    console.error(error);
                    setPathActionError(TRANSLATIONS[language].failed);
                  }
                }}
                className="inline-flex h-9 items-center rounded-lg bg-indigo-500 px-4 text-sm font-medium text-white transition-colors hover:bg-indigo-600"
              >
                {TRANSLATIONS[language].revealInFinder}
              </button>
              {pathActionError ? <p className="text-xs text-red-400">{pathActionError}</p> : null}
            </div>
          ) : (
            <pre
              className={`custom-scrollbar h-full w-full overflow-auto whitespace-pre-wrap rounded-lg p-4 font-mono text-sm ${
                theme === 'dark' ? 'bg-black/50 text-neutral-300' : 'border border-black/5 bg-white text-neutral-700'
              }`}
            >
              {clip.content}
            </pre>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
});

const ClipItem = memo(function ClipItem({
  clip,
  language,
  theme,
  isSelected,
  onSelect,
  onHoverStart,
  onHoverEnd,
  onPaste,
  onPreview,
  onCopy,
  onDelete,
  onTogglePinned,
  previewLabel,
  pinLabel,
}: {
  clip: ClipView;
  language: Language;
  theme: ThemeMode;
  isSelected: boolean;
  onSelect: () => void;
  onHoverStart: () => void;
  onHoverEnd: () => void;
  onPaste: () => void;
  onPreview: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onTogglePinned: () => void;
  previewLabel: string;
  pinLabel: string;
}) {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [copied, setCopied] = useState(false);
  const metaParts = [clip.source, categoryBadge(clip, language), formatRelativeTime(clip.timestamp, language)].filter(
    (value): value is string => Boolean(value),
  );

  const icon = useMemo(() => {
    if (getCategoryBucket(clip) === 'code') return <Code size={14} />;
    if (clip.type === 'image') return <ImageIcon size={14} />;
    if (clip.type === 'link') return <LinkIcon size={14} />;
    return <FileText size={14} />;
  }, [clip]);

  return (
    <div
      data-clip-id={clip.id}
      onMouseEnter={onHoverStart}
      onMouseLeave={onHoverEnd}
      onClick={onPaste}
      className={`group relative flex h-16 cursor-pointer items-center gap-3 rounded-xl px-3 py-2 transition-colors ${
        isSelected
          ? theme === 'dark'
            ? 'bg-indigo-500/15 text-white'
            : 'bg-indigo-500/10 text-indigo-900'
          : theme === 'dark'
            ? 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
            : 'text-neutral-600 hover:bg-black/5'
      }`}
    >
      <div
        className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg ${
          isSelected
            ? theme === 'dark'
              ? 'bg-indigo-500/20 text-indigo-300'
              : 'bg-indigo-500/20 text-indigo-600'
            : theme === 'dark'
              ? 'bg-white/5 text-neutral-500'
              : 'bg-black/5 text-neutral-400'
        }`}
      >
        {icon}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center overflow-hidden">
        {clip.type === 'image' && clip.preview ? (
          <div className="relative flex items-center gap-3">
            <div
              className={`relative h-10 w-14 flex-shrink-0 overflow-hidden rounded border ${
                theme === 'dark' ? 'border-white/10 bg-neutral-800' : 'border-black/10 bg-neutral-200'
              }`}
            >
              <img src={clip.preview} alt="Preview" className="h-full w-full object-cover" referrerPolicy="no-referrer" loading="lazy" decoding="async" />
            </div>
            <span className="truncate text-sm font-medium leading-5">{imageClipTitle(clip, language)}</span>
          </div>
        ) : (
          <span className={`truncate leading-5 ${clip.type === 'text' && clip.content.includes('\n') ? 'font-mono text-xs' : 'text-sm font-medium'}`}>
            {clip.content.split('\n')[0]}
          </span>
        )}
        <div className="mt-0.5 flex h-4 items-center gap-2 overflow-hidden text-[10px] opacity-60">
          {metaParts.map((part, index) => (
            <span
              key={`${clip.id}-${part}-${index}`}
              className={`truncate ${theme === 'dark' ? 'text-neutral-500' : 'text-neutral-500'} ${index > 0 ? 'border-l border-current/15 pl-2' : ''}`}
            >
              {part}
            </span>
          ))}
          {clip.isPinned ? (
            <span className={`truncate border-l border-current/15 pl-2 ${theme === 'dark' ? 'text-neutral-400' : 'text-neutral-600'}`}>
              {language === 'zh' ? '置顶' : 'Pinned'}
            </span>
          ) : null}
        </div>
      </div>

      {!showDeleteConfirm ? (
        <div
          className={`flex flex-shrink-0 items-center gap-1 ${
            isSelected ? 'opacity-100' : 'pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100'
          }`}
        >
          <button
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelect();
              onTogglePinned();
            }}
            className={`rounded-md p-1.5 transition-colors ${
              clip.isPinned
                ? 'bg-indigo-500/10 text-indigo-500'
                : theme === 'dark'
                  ? 'text-neutral-400 hover:bg-white/10 hover:text-white'
                  : 'text-neutral-500 hover:bg-black/5 hover:text-black'
            }`}
            title={pinLabel}
          >
            <Pin size={14} className={clip.isPinned ? 'fill-current' : ''} />
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
              onCopy();
            }}
            className={`rounded-md p-1.5 transition-colors ${
              copied
                ? 'bg-emerald-500/10 text-emerald-500'
                : theme === 'dark'
                  ? 'text-neutral-400 hover:bg-white/10 hover:text-white'
                  : 'text-neutral-500 hover:bg-black/5 hover:text-black'
            }`}
            title={TRANSLATIONS[language].copy}
          >
            {copied ? <Check size={14} /> : <Copy size={14} />}
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
              onPreview();
            }}
            className={`rounded-md p-1.5 transition-colors ${
              theme === 'dark' ? 'text-neutral-400 hover:bg-white/10 hover:text-white' : 'text-neutral-500 hover:bg-black/5 hover:text-black'
            }`}
            title={previewLabel}
          >
            <Maximize2 size={14} />
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onSelect();
              setShowDeleteConfirm(true);
            }}
            className={`rounded-md p-1.5 transition-colors ${
              theme === 'dark' ? 'text-neutral-400 hover:bg-red-500/20 hover:text-red-400' : 'text-neutral-500 hover:bg-red-500/10 hover:text-red-500'
            }`}
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ) : null}

      {showDeleteConfirm ? (
        <div className="flex flex-shrink-0 items-center gap-2">
          <span className="text-xs font-medium text-red-500">Delete?</span>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
              setShowDeleteConfirm(false);
            }}
            className="rounded-md bg-red-500/20 p-1 text-red-500 transition-colors hover:bg-red-500 hover:text-white"
          >
            <Check size={14} />
          </button>
          <button
            onClick={(event) => {
              event.stopPropagation();
              setShowDeleteConfirm(false);
            }}
            className={`rounded-md p-1 transition-colors ${
              theme === 'dark' ? 'bg-white/10 text-neutral-300 hover:bg-white/20' : 'bg-black/10 text-neutral-600 hover:bg-black/20'
            }`}
          >
            <X size={14} />
          </button>
        </div>
      ) : null}
    </div>
  );
}, (prev, next) => {
  return (
    prev.clip.id === next.clip.id &&
    prev.clip.content === next.clip.content &&
    prev.clip.preview === next.clip.preview &&
    prev.clip.source === next.clip.source &&
    prev.clip.resolvedCategory === next.clip.resolvedCategory &&
    prev.clip.isPinned === next.clip.isPinned &&
    prev.isSelected === next.isSelected &&
    prev.theme === next.theme &&
    prev.language === next.language &&
    prev.previewLabel === next.previewLabel &&
    prev.pinLabel === next.pinLabel
  );
});

function SettingsModal({
  settings,
  language,
  theme,
  panelOpacity,
  onThemeChange,
  onLanguageChange,
  onOpacityChange,
  onToggleLaunchAtLogin,
  onTogglePlaySounds,
  onToggleShortcutHints,
  onRetentionChange,
  onMaxClipsChange,
  onToggleIgnorePasswordManagers,
  onTogglePlainTextOnly,
  onSaveShortcut,
  onExport,
  onImport,
  onRestoreDefaults,
  onClearAll,
  onClose,
}: {
  settings: BackendSettings;
  language: Language;
  theme: ThemeMode;
  panelOpacity: number;
  onThemeChange: (value: ThemePreference) => void;
  onLanguageChange: (value: Language) => void;
  onOpacityChange: (value: number) => void;
  onToggleLaunchAtLogin: () => void;
  onTogglePlaySounds: () => void;
  onToggleShortcutHints: () => void;
  onRetentionChange: (value: string) => void;
  onMaxClipsChange: (value: string) => void;
  onToggleIgnorePasswordManagers: () => void;
  onTogglePlainTextOnly: () => void;
  onSaveShortcut: (type: 'screenshot' | 'toggle_window' | 'quick_paste' | 'clear_history', shortcut: string) => void;
  onExport: () => void;
  onImport: (file: File | null) => void;
  onRestoreDefaults: () => void;
  onClearAll: () => void;
  onClose: () => void;
}) {
  const t = TRANSLATIONS[language];
  const [activeTab, setActiveTab] = useState<'general' | 'shortcuts' | 'advanced'>('general');
  const [showConfirmClear, setShowConfirmClear] = useState(false);

  const retentionOptions: SelectOption[] = [
    { label: t.days1, value: '1' },
    { label: t.days7, value: '7' },
    { label: t.days30, value: '30' },
    { label: t.forever, value: '-1' },
  ];

  const maxClipOptions: SelectOption[] = [
    { label: '100', value: '100' },
    { label: '500', value: '500' },
    { label: '1000', value: '1000' },
    { label: t.unlimited, value: '-1' },
  ];

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-50 flex items-start justify-center pt-[10vh]">
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={onClose} className="absolute inset-0 bg-transparent" />

      <motion.div
        initial={{ opacity: 0, scale: 0.95, y: 10 }}
        animate={{ opacity: panelOpacity, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 10 }}
        transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
        className={`relative flex w-full max-w-2xl overflow-hidden rounded-2xl border shadow-2xl backdrop-blur-2xl ${
          theme === 'dark' ? 'border-white/10 bg-[#111111]' : 'border-black/10 bg-white'
        }`}
        style={{ height: '78vh', maxHeight: '78vh' }}
      >
        <div className={`flex w-56 flex-col gap-1 border-r p-4 ${theme === 'dark' ? 'border-white/5' : 'border-black/5'}`}>
          <div className="px-2 pb-4 pt-2">
            <h2 className={`text-sm font-semibold ${theme === 'dark' ? 'text-white' : 'text-black'}`}>{t.settings}</h2>
          </div>
          <SettingsTab theme={theme} active={activeTab === 'general'} onClick={() => setActiveTab('general')} icon={<Settings size={16} />} label={t.general} />
          <SettingsTab theme={theme} active={activeTab === 'shortcuts'} onClick={() => setActiveTab('shortcuts')} icon={<Keyboard size={16} />} label={t.shortcuts} />
          <SettingsTab theme={theme} active={activeTab === 'advanced'} onClick={() => setActiveTab('advanced')} icon={<Monitor size={16} />} label={t.advanced} />
        </div>

        <div className="relative flex flex-1 flex-col bg-transparent">
          <button
            onClick={onClose}
            title={t.closeSettings}
            className={`absolute right-4 top-4 z-10 rounded-md p-1.5 transition-colors ${
              theme === 'dark' ? 'text-neutral-500 hover:bg-white/10 hover:text-white' : 'text-neutral-400 hover:bg-black/5 hover:text-black'
            }`}
          >
            <X size={16} />
          </button>

          <div className="custom-scrollbar flex-1 overflow-y-auto px-8 pb-12 pt-14">
            <AnimatePresence mode="wait">
              {activeTab === 'general' ? (
                <motion.div key="general" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.15 }} className="space-y-8">
                  <div>
                    <h3 className={`mb-4 text-lg font-medium ${theme === 'dark' ? 'text-white' : 'text-black'}`}>{t.general}</h3>
                    <div className="space-y-4">
                      <SelectRow
                        theme={theme}
                        label={t.theme}
                        value={settings.theme ?? 'system'}
                        options={[
                          { label: t.system, value: 'system' },
                          { label: t.dark, value: 'dark' },
                          { label: t.light, value: 'light' },
                        ]}
                        onChange={(value) => onThemeChange(value as ThemePreference)}
                      />
                      <SelectRow theme={theme} label={t.language} value={language} options={[{ label: 'English', value: 'en' }, { label: '中文', value: 'zh' }]} onChange={(value) => onLanguageChange(value as Language)} />
                      <SliderSetting theme={theme} label={t.transparency} description={t.transparencyDesc} min={0} max={1} step={0.01} value={settings.window_opacity ?? 0.92} formatValue={(value) => `${Math.round(value * 100)}%`} onChange={onOpacityChange} />
                      <ToggleSetting theme={theme} label={t.launchAtLogin} description={t.launchAtLoginDesc} checked={settings.launch_at_login} onChange={onToggleLaunchAtLogin} />
                      <ToggleSetting theme={theme} label={t.playSounds} description={t.playSoundsDesc} checked={settings.play_sounds} onChange={onTogglePlaySounds} />
                      <ToggleSetting theme={theme} label={t.showShortcutHints} description={t.showShortcutHintsDesc} checked={settings.show_shortcut_hints} onChange={onToggleShortcutHints} />
                    </div>
                  </div>

                  <div className={`h-px ${theme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`} />

                  <div>
                    <h3 className={`mb-4 text-sm font-medium ${theme === 'dark' ? 'text-white' : 'text-black'}`}>{t.historyRetention}</h3>
                    <div className="space-y-3">
                      <SelectRow theme={theme} label={t.keepHistoryFor} value={String(settings.history_retention_days)} options={retentionOptions} onChange={onRetentionChange} />
                      <SelectRow theme={theme} label={t.maxClips} value={String(settings.max_clips)} options={maxClipOptions} onChange={onMaxClipsChange} />
                    </div>
                  </div>
                </motion.div>
              ) : null}

              {activeTab === 'shortcuts' ? (
                <motion.div key="shortcuts" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.15 }} className="space-y-8">
                  <div>
                    <h3 className={`mb-4 text-lg font-medium ${theme === 'dark' ? 'text-white' : 'text-black'}`}>{t.shortcuts}</h3>
                    <div className="space-y-4">
                      <ShortcutSetting theme={theme} label={t.screenshotShortcut} value={settings.screenshot_shortcut ?? 'Alt+S'} onChange={(value) => onSaveShortcut('screenshot', value)} />
                      <ShortcutSetting theme={theme} label={t.toggleClipboard} value={settings.toggle_window_shortcut ?? 'Alt+Space'} onChange={(value) => onSaveShortcut('toggle_window', value)} />
                      <ShortcutSetting theme={theme} label={t.quickPaste} value={settings.quick_paste_shortcut ?? 'CmdOrCtrl+Shift+V'} onChange={(value) => onSaveShortcut('quick_paste', value)} />
                      <ShortcutSetting theme={theme} label={t.clearHistoryShortcut} value={settings.clear_history_shortcut ?? 'CmdOrCtrl+Shift+Backspace'} onChange={(value) => onSaveShortcut('clear_history', value)} />
                    </div>
                  </div>
                  <div className={`rounded-xl border p-4 text-sm ${theme === 'dark' ? 'border-indigo-500/20 bg-indigo-500/10 text-indigo-200' : 'border-indigo-200 bg-indigo-50 text-indigo-800'}`}>
                    <p>{t.shortcutHint}</p>
                  </div>
                </motion.div>
              ) : null}

              {activeTab === 'advanced' ? (
                <motion.div key="advanced" initial={{ opacity: 0, x: 10 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -10 }} transition={{ duration: 0.15 }} className="space-y-8">
                  <div>
                    <h3 className={`mb-4 text-lg font-medium ${theme === 'dark' ? 'text-white' : 'text-black'}`}>{t.advanced}</h3>
                    <div className="space-y-4">
                      <ToggleSetting theme={theme} label={t.ignorePasswordManagers} description={t.ignorePasswordManagersDesc} checked={settings.ignore_password_managers} onChange={onToggleIgnorePasswordManagers} />
                      <ToggleSetting theme={theme} label={t.plainTextOnly} description={t.plainTextOnlyDesc} checked={settings.plain_text_only} onChange={onTogglePlainTextOnly} />
                    </div>
                  </div>

                  <div className={`h-px ${theme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`} />

                  <div>
                    <h3 className={`mb-4 text-sm font-medium ${theme === 'dark' ? 'text-white' : 'text-black'}`}>{t.dataManagement}</h3>
                    <div className="space-y-4">
                      <ActionRow theme={theme} title={t.exportHistory} description={t.exportDesc} actionLabel={t.exportHistory} onClick={onExport} />
                      <ActionRow theme={theme} title={t.restoreDefaults} description={t.restoreDefaultsDesc} actionLabel={t.restoreDefaults} onClick={onRestoreDefaults} />
                      <div className="flex items-center justify-between">
                        <div>
                          <div className={`text-sm font-medium ${theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800'}`}>{t.importHistory}</div>
                          <div className="mt-0.5 text-xs text-neutral-500">{t.importDesc}</div>
                        </div>
                        <label className={`inline-flex h-8 shrink-0 cursor-pointer items-center whitespace-nowrap rounded-lg px-3 text-xs font-medium transition-colors ${theme === 'dark' ? 'bg-white/5 text-neutral-200 hover:bg-white/10' : 'bg-black/5 text-neutral-800 hover:bg-black/10'}`}>
                          {t.importHistory}
                          <input
                            type="file"
                            accept=".json,application/json"
                            className="hidden"
                            onChange={(event) => {
                              const file = event.target.files?.[0] ?? null;
                              void onImport(file);
                              event.currentTarget.value = '';
                            }}
                          />
                        </label>
                      </div>
                    </div>
                  </div>

                  <div className={`h-px ${theme === 'dark' ? 'bg-white/5' : 'bg-black/5'}`} />

                  <div>
                    <h3 className="mb-4 text-sm font-medium text-red-500">{t.dangerZone}</h3>
                    {!showConfirmClear ? (
                      <div>
                        <button
                          onClick={() => setShowConfirmClear(true)}
                          className={`rounded-lg border px-4 py-2 text-sm font-medium transition-colors ${
                            theme === 'dark' ? 'border-red-500/20 bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100'
                          }`}
                        >
                          {t.clearAllHistory}
                        </button>
                        <p className="mt-2 text-xs text-neutral-500">{t.clearWarning}</p>
                      </div>
                    ) : (
                      <div className={`rounded-xl border p-4 ${theme === 'dark' ? 'border-red-500/20 bg-red-500/10' : 'border-red-200 bg-red-50'}`}>
                        <div className="flex items-start gap-3">
                          <AlertTriangle className={theme === 'dark' ? 'mt-0.5 text-red-400' : 'mt-0.5 text-red-500'} size={18} />
                          <div>
                            <h4 className={`text-sm font-medium ${theme === 'dark' ? 'text-red-400' : 'text-red-600'}`}>{t.confirmClear}</h4>
                            <p className={`mb-4 mt-1 text-xs ${theme === 'dark' ? 'text-red-400/70' : 'text-red-600/70'}`}>{t.clearWarning}</p>
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => {
                                  onClearAll();
                                  setShowConfirmClear(false);
                                }}
                                className="rounded-md bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600"
                              >
                                {t.confirm}
                              </button>
                              <button
                                onClick={() => setShowConfirmClear(false)}
                                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                                  theme === 'dark' ? 'bg-white/5 text-neutral-300 hover:bg-white/10' : 'bg-black/5 text-neutral-700 hover:bg-black/10'
                                }`}
                              >
                                {t.cancel}
                              </button>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </motion.div>
              ) : null}
            </AnimatePresence>
          </div>
        </div>
      </motion.div>
    </div>
  );
}

function ShortcutHint({ theme, keys, label }: { theme: ThemeMode; keys: string[]; label: string }) {
  return (
    <span className="flex items-center gap-1 whitespace-nowrap">
      {keys.map((key) => (
        <kbd key={key} className={`rounded px-1 font-mono ${theme === 'dark' ? 'bg-white/10' : 'bg-black/10'}`}>
          {key}
        </kbd>
      ))}
      {label}
    </span>
  );
}

function SettingsTab({
  theme,
  active,
  onClick,
  icon,
  label,
}: {
  theme: ThemeMode;
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors ${
        active
          ? theme === 'dark'
            ? 'bg-white/10 text-white'
            : 'bg-black/10 text-black'
          : theme === 'dark'
            ? 'text-neutral-400 hover:bg-white/5 hover:text-neutral-200'
            : 'text-neutral-600 hover:bg-black/5 hover:text-neutral-800'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

function ToggleSetting({
  theme,
  label,
  description,
  checked,
  onChange,
}: {
  theme: ThemeMode;
  label: string;
  description: string;
  checked: boolean;
  onChange: () => void;
}) {
  return (
    <div className="group flex items-center justify-between">
      <div className="pr-4">
        <div className={`text-sm font-medium ${theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800'}`}>{label}</div>
        <div className="mt-0.5 text-xs text-neutral-500">{description}</div>
      </div>
      <button
        type="button"
        onClick={onChange}
        className={`relative inline-flex h-6 w-10 flex-shrink-0 items-center rounded-full p-1 transition-colors ${
          checked ? 'bg-indigo-500' : theme === 'dark' ? 'bg-white/10' : 'bg-black/10'
        }`}
      >
        <span className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? 'translate-x-4' : 'translate-x-0'}`} />
      </button>
    </div>
  );
}

function SelectRow({
  theme,
  label,
  value,
  options,
  onChange,
}: {
  theme: ThemeMode;
  label: string;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const current = options.find((option) => option.value === value) ?? options[0];

  return (
    <div className="relative flex items-center justify-between">
      <div className={`text-sm font-medium ${theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800'}`}>{label}</div>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className={`inline-flex h-8 min-w-[128px] items-center justify-between rounded-lg border px-3 text-sm transition-colors ${
          theme === 'dark'
            ? 'border-white/10 bg-white/5 text-neutral-200 hover:bg-white/10'
            : 'border-black/10 bg-black/5 text-neutral-800 hover:bg-black/10'
        }`}
      >
        <span>{current?.label}</span>
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence>
        {open ? (
          <motion.div
            initial={{ opacity: 0, y: 6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
            className={`absolute right-0 top-10 z-30 min-w-[156px] rounded-xl border p-1 shadow-2xl ${
              theme === 'dark' ? 'border-white/10 bg-[#191919]' : 'border-black/10 bg-white'
            }`}
          >
            {options.map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between rounded-lg px-3 py-2 text-sm transition-colors ${
                  option.value === value
                    ? theme === 'dark'
                      ? 'bg-white/10 text-white'
                      : 'bg-black/10 text-black'
                    : theme === 'dark'
                      ? 'text-neutral-300 hover:bg-white/5'
                      : 'text-neutral-700 hover:bg-black/5'
                }`}
              >
                <span>{option.label}</span>
                {option.value === value ? <Check size={14} className="text-indigo-500" /> : null}
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function SliderSetting({
  theme,
  label,
  description,
  min,
  max,
  step,
  value,
  formatValue,
  onChange,
}: {
  theme: ThemeMode;
  label: string;
  description: string;
  min: number;
  max: number;
  step: number;
  value: number;
  formatValue: (value: number) => string;
  onChange: (value: number) => void;
}) {
  const progress = `${((value - min) / (max - min)) * 100}%`;

  return (
    <div className="space-y-2">
      <div className="flex items-end justify-between gap-3">
        <div className="min-w-0">
          <div className={`text-sm font-medium ${theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800'}`}>{label}</div>
          <div className="mt-0.5 text-xs text-neutral-500">{description}</div>
        </div>
        <span className="flex-shrink-0 text-[11px] font-medium text-neutral-500">{formatValue(value)}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        className="h-2 w-full cursor-pointer appearance-none rounded-full bg-transparent"
        style={{
          background:
            theme === 'dark'
              ? `linear-gradient(to right, rgb(99 102 241) 0%, rgb(99 102 241) ${progress}, rgba(255,255,255,0.08) ${progress}, rgba(255,255,255,0.08) 100%)`
              : `linear-gradient(to right, rgb(99 102 241) 0%, rgb(99 102 241) ${progress}, rgba(0,0,0,0.08) ${progress}, rgba(0,0,0,0.08) 100%)`,
        }}
      />
    </div>
  );
}

function ActionRow({
  theme,
  title,
  description,
  actionLabel,
  onClick,
}: {
  theme: ThemeMode;
  title: string;
  description: string;
  actionLabel: string;
  onClick: () => void;
}) {
  return (
    <div className="flex items-center justify-between">
      <div>
        <div className={`text-sm font-medium ${theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800'}`}>{title}</div>
        <div className="mt-0.5 text-xs text-neutral-500">{description}</div>
      </div>
      <button
        onClick={onClick}
        className={`inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-lg px-3 text-xs font-medium transition-colors ${
          theme === 'dark' ? 'bg-white/5 text-neutral-200 hover:bg-white/10' : 'bg-black/5 text-neutral-800 hover:bg-black/10'
        }`}
      >
        {actionLabel}
      </button>
    </div>
  );
}

function ShortcutSetting({
  theme,
  label,
  value,
  onChange,
}: {
  theme: ThemeMode;
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!isRecording) return;

    const captureShortcut = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();

      if (event.key === 'Escape') {
        setIsRecording(false);
        return;
      }

      const parts: string[] = [];
      if (event.metaKey) parts.push('Meta');
      if (event.ctrlKey) parts.push('Ctrl');
      if (event.altKey) parts.push('Alt');
      if (event.shiftKey) parts.push('Shift');

      const normalizedKey = normalizeShortcutKey(event.key);
      if (!normalizedKey) return;
      if (!parts.includes(normalizedKey)) parts.push(normalizedKey);

      onChange(parts.join('+'));
      setIsRecording(false);
    };

    window.addEventListener('keydown', captureShortcut, true);
    return () => window.removeEventListener('keydown', captureShortcut, true);
  }, [isRecording, onChange]);

  return (
    <div className="flex items-center justify-between">
      <div className={`text-sm font-medium ${theme === 'dark' ? 'text-neutral-200' : 'text-neutral-800'}`}>{label}</div>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setIsRecording(true)}
        className={`inline-flex h-8 min-w-[132px] items-center rounded-lg border px-3 text-sm outline-none transition-colors ${
          theme === 'dark'
            ? 'border-white/10 bg-white/5 text-neutral-200 focus:border-indigo-500/50'
            : 'border-black/10 bg-black/5 text-neutral-800 focus:border-indigo-500/50'
        }`}
      >
        <span className="font-mono">{isRecording ? '...' : shortcutToDisplay(value)}</span>
      </button>
    </div>
  );
}

function normalizeShortcutKey(key: string) {
  const lower = key.toLowerCase();

  if (lower === 'meta' || lower === 'control' || lower === 'alt' || lower === 'shift') {
    return null;
  }

  if (lower === ' ') return 'Space';
  if (lower === 'arrowup') return 'Up';
  if (lower === 'arrowdown') return 'Down';
  if (lower === 'arrowleft') return 'Left';
  if (lower === 'arrowright') return 'Right';
  if (lower === 'escape') return 'Esc';
  if (lower === 'enter') return 'Enter';
  if (lower === 'tab') return 'Tab';
  if (lower === 'backspace') return 'Backspace';
  if (lower === 'delete') return 'Delete';
  if (lower.length === 1) return lower.toUpperCase();

  return key.length ? key[0].toUpperCase() + key.slice(1) : null;
}
