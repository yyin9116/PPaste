import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
  Check,
  ChevronDown,
  Database,
  Loader2,
  Search,
  Settings,
  Trash2,
  X,
} from 'lucide-react';
import {
  clearAllClips,
  deleteClip,
  getClips,
  getSettings,
  getStats,
  listenToNewClip,
  pasteClip,
  setRunAtLogin,
  updateSettings,
  updateShortcut,
  writeToClipboard,
  type BackendClip,
  type BackendSettings,
  type ClipStats,
} from '../lib/tauri';

type ThemeMode = 'dark' | 'light';
type Language = 'zh' | 'en';

type SelectOption = {
  value: string;
  label: string;
};

interface ClipView {
  id: string;
  content: string;
  preview?: string;
  type: BackendClip['clip_type'];
  source?: string;
  timestamp: number;
}

function mapClip(clip: BackendClip): ClipView {
  return {
    id: clip.id,
    content: clip.content,
    preview:
      clip.clip_type === 'image' && clip.content && !clip.content.startsWith('data:')
        ? `data:image/png;base64,${clip.content}`
        : clip.preview,
    type: clip.clip_type,
    source: clip.source,
    timestamp: clip.timestamp,
  };
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

export default function DesktopEnvironment() {
  const [theme, setTheme] = useState<ThemeMode>('dark');
  const [language, setLanguage] = useState<Language>('zh');
  const [settingsData, setSettingsData] = useState<BackendSettings | null>(null);

  const [clips, setClips] = useState<ClipView[]>([]);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);

  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [showConfirmClear, setShowConfirmClear] = useState(false);

  const [stats, setStats] = useState<ClipStats | null>(null);
  const [isSyncing, setIsSyncing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [shortcutSaving, setShortcutSaving] = useState<'screenshot' | 'toggle_window' | null>(null);
  const [screenshotShortcutInput, setScreenshotShortcutInput] = useState('');
  const [toggleShortcutInput, setToggleShortcutInput] = useState('');

  const t =
    language === 'zh'
      ? {
          title: 'PPaste',
          search: '搜索剪贴板历史...',
          noResult: '未找到相关内容',
          emptyHint: '尝试不同关键词',
          copied: '已复制到系统剪贴板',
          pasted: '已粘贴到当前输入位置',
          deleted: '已删除记录',
          cleared: '已清空历史',
          failed: '操作失败，请重试',
          loading: '同步中...',
          settings: '设置',
          theme: '主题',
          language: '语言',
          dark: '深色',
          light: '浅色',
          launchAtLogin: '开机启动',
          launchAtLoginDesc: '系统登录后自动启动 PPaste。',
          shortcuts: '快捷键绑定',
          shortcutsDesc: '点击录制后直接按键。也可以一键选择双击 Command 触发。',
          screenshotShortcut: '截图快捷键',
          toggleWindowShortcut: '显示/隐藏窗口',
          shortcutPlaceholder: '点击后按下快捷键',
          shortcutRecord: '点击录制',
          shortcutRecording: '按下快捷键...',
          shortcutDoubleCommand: '双击 Command',
          shortcutClear: '清空',
          save: '保存',
          saved: '快捷键已更新',
          invalidShortcut: '请输入有效快捷键',
          playSounds: '提示音',
          playSoundsDesc: '复制或粘贴时播放提示音。',
          dataStatus: '数据状态',
          totalClips: '总条目',
          totalSize: '数据体积',
          dbPath: '数据库路径',
          danger: '危险操作',
          clearAll: '清空全部历史',
          clearWarn: '该操作不可恢复，请谨慎执行。',
          confirm: '确认清空',
          cancel: '取消',
          close: '关闭',
        }
      : {
          title: 'PPaste',
          search: 'Search clipboard history...',
          noResult: 'No clips found',
          emptyHint: 'Try another keyword',
          copied: 'Copied to system clipboard',
          pasted: 'Pasted into the active field',
          deleted: 'Clip deleted',
          cleared: 'History cleared',
          failed: 'Action failed',
          loading: 'Syncing...',
          settings: 'Settings',
          theme: 'Theme',
          language: 'Language',
          dark: 'Dark',
          light: 'Light',
          launchAtLogin: 'Launch at login',
          launchAtLoginDesc: 'Start PPaste at system login.',
          shortcuts: 'Shortcut bindings',
          shortcutsDesc: 'Click record and press the shortcut. You can also choose double-Command directly.',
          screenshotShortcut: 'Screenshot shortcut',
          toggleWindowShortcut: 'Show/Hide window',
          shortcutPlaceholder: 'Click and press a shortcut',
          shortcutRecord: 'Record',
          shortcutRecording: 'Press shortcut...',
          shortcutDoubleCommand: 'Double Command',
          shortcutClear: 'Clear',
          save: 'Save',
          saved: 'Shortcut updated',
          invalidShortcut: 'Please enter a valid shortcut',
          playSounds: 'Play sounds',
          playSoundsDesc: 'Play subtle feedback on actions.',
          dataStatus: 'Data Status',
          totalClips: 'Total clips',
          totalSize: 'Data size',
          dbPath: 'Database path',
          danger: 'Danger',
          clearAll: 'Clear all history',
          clearWarn: 'This action cannot be undone.',
          confirm: 'Confirm',
          cancel: 'Cancel',
          close: 'Close',
        };

  const themeOptions: SelectOption[] = [
    { value: 'dark', label: t.dark },
    { value: 'light', label: t.light },
  ];

  const languageOptions: SelectOption[] = [
    { value: 'zh', label: '中文' },
    { value: 'en', label: 'English' },
  ];

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return clips.filter((c) => q.length === 0 || c.content.toLowerCase().includes(q) || c.source?.toLowerCase().includes(q));
  }, [clips, query]);

  const showToast = (message: string) => {
    setToast(message);
    setTimeout(() => setToast(null), 1800);
  };

  const refreshStats = async () => {
    try {
      setStats(await getStats());
    } catch (e) {
      console.error(e);
    }
  };

  const syncData = async (options?: { silent?: boolean }) => {
    const silent = options?.silent ?? false;
    try {
      if (!silent) setIsSyncing(true);
      const [clipRows, settingsRows] = await Promise.all([getClips(200, 0), getSettings()]);
      setClips(clipRows.map(mapClip));
      setSettingsData(settingsRows);
      setTheme((settingsRows.theme as ThemeMode) || 'dark');
      setLanguage((settingsRows.language as Language) || 'zh');
    } catch (e) {
      console.error(e);
    } finally {
      if (!silent) setIsSyncing(false);
    }
  };

  const patchSettings = async (next: Partial<BackendSettings>) => {
    if (!settingsData) return;
    const merged = { ...settingsData, ...next };
    setSettingsData(merged);
    if (next.theme) setTheme(next.theme as ThemeMode);
    if (next.language) setLanguage(next.language as Language);
    try {
      await updateSettings(merged);
    } catch (e) {
      console.error(e);
      showToast(t.failed);
    }
  };

  const saveShortcut = async (shortcutType: 'screenshot' | 'toggle_window', value: string) => {
    const shortcut = value.trim();
    if (!shortcut) {
      showToast(t.invalidShortcut);
      return;
    }

    setShortcutSaving(shortcutType);
    try {
      await updateShortcut(shortcutType, shortcut);
      setSettingsData((prev) => {
        if (!prev) return prev;
        return shortcutType === 'screenshot'
          ? { ...prev, screenshot_shortcut: shortcut }
          : { ...prev, toggle_window_shortcut: shortcut };
      });
      showToast(t.saved);
    } catch (e) {
      console.error(e);
      showToast(t.failed);
    } finally {
      setShortcutSaving(null);
    }
  };

  const copyClip = async (clip: ClipView) => {
    try {
      if (clip.type === 'text') {
        await pasteClip(clip.content, clip.type);
        showToast(t.pasted);
      } else {
        await writeToClipboard(clip.content, clip.type);
        showToast(t.copied);
      }
    } catch (e) {
      console.error(e);
      showToast(t.failed);
    }
  };

  const removeClip = async (id: string) => {
    try {
      await deleteClip(id);
      setClips((prev) => prev.filter((x) => x.id !== id));
      showToast(t.deleted);
    } catch (e) {
      console.error(e);
      showToast(t.failed);
    }
  };

  useEffect(() => {
    if (!settingsData) return;
    setScreenshotShortcutInput(settingsData.screenshot_shortcut ?? 'Alt+S');
    setToggleShortcutInput(settingsData.toggle_window_shortcut ?? 'Alt+Space');
  }, [settingsData?.screenshot_shortcut, settingsData?.toggle_window_shortcut]);

  useEffect(() => {
    void syncData();
    const interval = setInterval(() => void syncData({ silent: true }), 30000);
    const unlistenPromise = listenToNewClip((clip) => {
      setClips((prev) => {
        if (prev.some((x) => x.id === clip.id)) return prev;
        return [mapClip(clip), ...prev].slice(0, 500);
      });
    });
    return () => {
      clearInterval(interval);
      void unlistenPromise.then((u) => u());
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey && event.key === ',') {
        event.preventDefault();
        setIsSettingsOpen(true);
        void refreshStats();
        return;
      }
      if (event.key === 'Escape') {
        setIsSettingsOpen(false);
        return;
      }
      if (isSettingsOpen) return;
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setSelectedIndex((prev) => Math.min(prev + 1, Math.max(filtered.length - 1, 0)));
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setSelectedIndex((prev) => Math.max(prev - 1, 0));
      }
      if (event.key === 'Enter') {
        event.preventDefault();
        const selected = filtered[selectedIndex];
        if (selected) void copyClip(selected);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [filtered, selectedIndex, isSettingsOpen]);

  return (
    <div
      className={`relative h-screen w-full overflow-hidden rounded-[16px] font-sans ${
        theme === 'dark' ? 'bg-gray-950 text-gray-100' : 'bg-gray-50 text-gray-900'
      }`}
    >
      <div className="absolute inset-0 z-0 opacity-40">
        <div
          className={`absolute left-[-10%] top-[-20%] h-[50%] w-[50%] rounded-full blur-[120px] ${
            theme === 'dark' ? 'bg-teal-900/35' : 'bg-teal-200/60'
          }`}
        />
        <div
          className={`absolute bottom-[-20%] right-[-10%] h-[60%] w-[60%] rounded-full blur-[150px] ${
            theme === 'dark' ? 'bg-indigo-900/20' : 'bg-indigo-200/50'
          }`}
        />
      </div>

      <div className="relative z-10 flex h-full w-full">
        <div
          className={`flex h-full w-full flex-col overflow-hidden border ${
            theme === 'dark' ? 'border-gray-800 bg-gray-900/90' : 'border-gray-100 bg-white/95'
          }`}
        >
          <div className={`border-b px-4 py-4 ${theme === 'dark' ? 'border-gray-800' : 'border-gray-100'}`}>
            <div className="mb-3 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <img src="/logo.svg" alt="PPaste" className="h-5 w-5" />
                <span className="text-sm font-semibold tracking-tight">{t.title}</span>
              </div>
              <button
                onClick={() => {
                  setIsSettingsOpen(true);
                  void refreshStats();
                }}
                className={`rounded-lg p-2 transition-colors ${
                  theme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                }`}
              >
                <Settings className="h-4 w-4" />
              </button>
            </div>

            <div className="flex items-center gap-3">
              <Search className="h-5 w-5 text-gray-400" />
              <input
                autoFocus
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelectedIndex(0);
                }}
                placeholder={t.search}
                className={`w-full bg-transparent text-lg font-light outline-none ${
                  theme === 'dark' ? 'text-gray-100 placeholder:text-gray-500' : 'text-gray-900 placeholder:text-gray-400'
                }`}
              />
            </div>
          </div>

          <div className="custom-scrollbar flex-1 space-y-1 overflow-y-auto p-2">
            {clips.length === 0 && isSyncing ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-gray-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                {t.loading}
              </div>
            ) : filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 text-gray-500">
                <Search className="mb-4 h-10 w-10 opacity-50" />
                <p className="text-sm font-medium">{t.noResult}</p>
                <p className="mt-1 text-xs">{t.emptyHint}</p>
              </div>
            ) : (
              filtered.map((clip, index) => (
                <div
                  key={clip.id}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => void copyClip(clip)}
                  className={`group flex cursor-pointer items-center gap-3 rounded-xl px-3 py-2.5 transition-all ${
                    index === selectedIndex
                      ? theme === 'dark'
                        ? 'bg-teal-500/15 text-white'
                        : 'bg-teal-500/10 text-teal-900'
                      : theme === 'dark'
                        ? 'text-gray-300 hover:bg-white/5'
                        : 'text-gray-700 hover:bg-gray-100'
                  }`}
                >
                  <div className={`min-w-0 flex-1 ${clip.type === 'image' ? 'font-mono text-xs' : 'text-sm'}`}>
                    {clip.type === 'image' && clip.preview ? (
                      <div className="flex items-center gap-3">
                        <img
                          src={clip.preview}
                          alt="preview"
                          className="h-8 w-12 rounded-md border border-white/10 object-cover"
                          referrerPolicy="no-referrer"
                        />
                        <span className="truncate text-sm">Image Clip</span>
                      </div>
                    ) : (
                      <span className="block truncate">{clip.content.split('\n')[0] || clip.content}</span>
                    )}
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-gray-500">
                      <span>{clip.source || 'Unknown'}</span>
                      <span>•</span>
                      <span>{formatRelativeTime(clip.timestamp, language)}</span>
                    </div>
                  </div>
                  <button
                    onClick={(event) => {
                      event.stopPropagation();
                      void removeClip(clip.id);
                    }}
                    className={`rounded-lg p-1.5 transition-colors ${
                      theme === 'dark' ? 'hover:bg-red-500/20 hover:text-red-300' : 'hover:bg-red-100 hover:text-red-600'
                    }`}
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isSettingsOpen && (
          <motion.div
            className="absolute inset-0 z-40"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
          >
            <div
              className={`absolute inset-0 flex h-full w-full flex-col overflow-hidden border ${
                theme === 'dark' ? 'border-gray-800 bg-gray-900' : 'border-gray-100 bg-white'
              }`}
            >
              <div className={`flex items-center justify-between border-b px-4 py-4 ${theme === 'dark' ? 'border-gray-800' : 'border-gray-100'}`}>
                <h3 className="text-lg font-semibold tracking-tight">{t.settings}</h3>
                <button
                  onClick={() => setIsSettingsOpen(false)}
                  className={`rounded-lg p-2 transition-colors ${
                    theme === 'dark' ? 'hover:bg-white/10' : 'hover:bg-black/10'
                  }`}
                >
                  <X className="h-4 w-4" />
                </button>
              </div>

              <div className="custom-scrollbar flex-1 overflow-y-auto p-6">
                <div className="space-y-4">
                  <SettingRow
                    theme={theme}
                    label={t.theme}
                    control={
                      <FlatSelect
                        theme={theme}
                        value={theme}
                        options={themeOptions}
                        onChange={(value) => void patchSettings({ theme: value })}
                      />
                    }
                  />

                  <SettingRow
                    theme={theme}
                    label={t.language}
                    control={
                      <FlatSelect
                        theme={theme}
                        value={language}
                        options={languageOptions}
                        onChange={(value) => void patchSettings({ language: value })}
                      />
                    }
                  />

                  <SettingRow
                    theme={theme}
                    label={t.launchAtLogin}
                    description={t.launchAtLoginDesc}
                    control={
                      <Switch
                        checked={settingsData?.launch_at_login ?? true}
                        onToggle={async () => {
                          const next = !(settingsData?.launch_at_login ?? true);
                          await setRunAtLogin(next);
                          await patchSettings({ launch_at_login: next });
                        }}
                      />
                    }
                  />

                  <SettingRow
                    theme={theme}
                    label={t.playSounds}
                    description={t.playSoundsDesc}
                    control={
                      <Switch
                        checked={settingsData?.play_sounds ?? false}
                        onToggle={() => void patchSettings({ play_sounds: !(settingsData?.play_sounds ?? false) })}
                      />
                    }
                  />

                  <div
                    className={`rounded-xl border p-4 ${
                      theme === 'dark' ? 'border-gray-800 bg-gray-950/50' : 'border-gray-100 bg-gray-50'
                    }`}
                  >
                    <div className="mb-1 text-sm font-semibold tracking-tight">{t.shortcuts}</div>
                    <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">{t.shortcutsDesc}</p>

                    <div className="space-y-2">
                      <SettingRow
                        theme={theme}
                        label={t.screenshotShortcut}
                        control={
                          <ShortcutInput
                            theme={theme}
                            value={screenshotShortcutInput}
                            placeholder={t.shortcutPlaceholder}
                            disabled={shortcutSaving === 'screenshot'}
                            onChange={setScreenshotShortcutInput}
                            onSave={() => void saveShortcut('screenshot', screenshotShortcutInput)}
                            saveLabel={shortcutSaving === 'screenshot' ? t.loading : t.save}
                            recordLabel={t.shortcutRecord}
                            recordingLabel={t.shortcutRecording}
                            doubleCommandLabel={t.shortcutDoubleCommand}
                            clearLabel={t.shortcutClear}
                          />
                        }
                      />

                      <SettingRow
                        theme={theme}
                        label={t.toggleWindowShortcut}
                        control={
                          <ShortcutInput
                            theme={theme}
                            value={toggleShortcutInput}
                            placeholder={t.shortcutPlaceholder}
                            disabled={shortcutSaving === 'toggle_window'}
                            onChange={setToggleShortcutInput}
                            onSave={() => void saveShortcut('toggle_window', toggleShortcutInput)}
                            saveLabel={shortcutSaving === 'toggle_window' ? t.loading : t.save}
                            recordLabel={t.shortcutRecord}
                            recordingLabel={t.shortcutRecording}
                            doubleCommandLabel={t.shortcutDoubleCommand}
                            clearLabel={t.shortcutClear}
                          />
                        }
                      />
                    </div>
                  </div>

                  <div
                    className={`rounded-xl border p-4 ${
                      theme === 'dark' ? 'border-gray-800 bg-gray-950/50' : 'border-gray-100 bg-gray-50'
                    }`}
                  >
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold tracking-tight">
                      <Database className="h-4 w-4" />
                      {t.dataStatus}
                    </div>
                    <div className="space-y-1 text-sm text-gray-500">
                      <div className="flex items-center justify-between">
                        <span>{t.totalClips}</span>
                        <span className="font-mono">{stats?.total_clips ?? clips.length}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span>{t.totalSize}</span>
                        <span className="font-mono">{stats ? `${stats.total_size_mb.toFixed(2)} MB` : '--'}</span>
                      </div>
                      <div>
                        <span>{t.dbPath}</span>
                        <p className="break-all font-mono text-xs">{stats?.database_path ?? '--'}</p>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h3 className="mb-3 text-sm font-semibold tracking-tight text-red-500">{t.danger}</h3>
                    {!showConfirmClear ? (
                      <div>
                        <button
                          onClick={() => setShowConfirmClear(true)}
                          className={`appearance-none rounded-xl border px-4 py-2 text-sm font-medium transition-colors ${
                            theme === 'dark'
                              ? 'border-red-500/30 bg-red-500/10 text-red-300 hover:bg-red-500/20'
                              : 'border-red-200 bg-red-50 text-red-600 hover:bg-red-100'
                          }`}
                        >
                          {t.clearAll}
                        </button>
                        <p className="mt-2 text-xs text-gray-500">{t.clearWarn}</p>
                      </div>
                    ) : (
                      <div
                        className={`rounded-xl border p-4 ${
                          theme === 'dark' ? 'border-red-500/30 bg-red-500/10' : 'border-red-200 bg-red-50'
                        }`}
                      >
                        <div className="mt-3 flex items-center gap-2">
                          <button
                            onClick={async () => {
                              await clearAllClips();
                              setClips([]);
                              setShowConfirmClear(false);
                              showToast(t.cleared);
                              await refreshStats();
                            }}
                            className="appearance-none rounded-lg bg-red-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-red-600"
                          >
                            {t.confirm}
                          </button>
                          <button
                            onClick={() => setShowConfirmClear(false)}
                            className={`appearance-none rounded-lg px-3 py-1.5 text-xs transition-colors ${
                              theme === 'dark' ? 'bg-white/10 hover:bg-white/20' : 'bg-black/10 hover:bg-black/20'
                            }`}
                          >
                            {t.cancel}
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {toast && (
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.9 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.9 }}
            className="absolute bottom-8 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full border border-teal-500/30 bg-teal-500/10 px-4 py-2 text-sm font-medium text-teal-300 backdrop-blur-md"
          >
            <Check className="h-4 w-4" />
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function SettingRow({
  theme,
  label,
  description,
  control,
}: {
  theme: ThemeMode;
  label: string;
  description?: string;
  control: ReactNode;
}) {
  return (
    <div className={`flex items-center justify-between border-b py-3 ${theme === 'dark' ? 'border-gray-800' : 'border-gray-100'}`}>
      <div>
        <span className="text-sm font-medium tracking-tight">{label}</span>
        {description ? <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">{description}</p> : null}
      </div>
      {control}
    </div>
  );
}

function Switch({
  checked,
  onToggle,
}: {
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center overflow-hidden rounded-full p-0.5 transition-all focus:outline-none focus:ring-2 focus:ring-teal-500 ${
        checked ? 'bg-teal-500' : 'bg-gray-300 dark:bg-gray-700'
      }`}
    >
      <span
        className={`pointer-events-none h-5 w-5 rounded-full bg-white shadow-sm transition-transform ${checked ? 'translate-x-5' : 'translate-x-0'}`}
      />
    </button>
  );
}

function ShortcutInput({
  theme,
  value,
  placeholder,
  saveLabel,
  recordLabel,
  recordingLabel,
  doubleCommandLabel,
  clearLabel,
  disabled,
  onChange,
  onSave,
}: {
  theme: ThemeMode;
  value: string;
  placeholder: string;
  saveLabel: string;
  recordLabel: string;
  recordingLabel: string;
  doubleCommandLabel: string;
  clearLabel: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSave: () => void;
}) {
  const [isRecording, setIsRecording] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (isRecording) {
      triggerRef.current?.focus();
    }
  }, [isRecording]);

  const captureShortcut = (event: React.KeyboardEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'Escape') {
      setIsRecording(false);
      return;
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      onChange('');
      setIsRecording(false);
      return;
    }

    const parts: string[] = [];
    if (event.metaKey) parts.push('Meta');
    if (event.ctrlKey) parts.push('Ctrl');
    if (event.altKey) parts.push('Alt');
    if (event.shiftKey) parts.push('Shift');

    const normalizedKey = normalizeShortcutKey(event.key);
    if (!normalizedKey) {
      return;
    }

    if (!parts.includes(normalizedKey)) {
      parts.push(normalizedKey);
    }

    onChange(parts.join('+'));
    setIsRecording(false);
  };

  return (
    <div className="flex items-center gap-2">
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setIsRecording(true)}
        onKeyDown={captureShortcut}
        className={`w-[180px] rounded-xl border px-3 py-2 text-left font-mono text-xs transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 ${
          theme === 'dark'
            ? 'border-gray-700 bg-gray-800 text-gray-100'
            : 'border-gray-200 bg-gray-50 text-gray-900'
        } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
      >
        {isRecording ? recordingLabel : value || placeholder}
      </button>
      <button
        type="button"
        onClick={() => {
          setIsRecording(true);
          requestAnimationFrame(() => triggerRef.current?.focus());
        }}
        disabled={disabled}
        className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
          disabled
            ? 'cursor-not-allowed bg-gray-400/40 text-white'
            : theme === 'dark'
              ? 'bg-white/10 text-white hover:bg-white/15'
              : 'bg-black/10 text-gray-900 hover:bg-black/15'
        }`}
      >
        {recordLabel}
      </button>
      <button
        type="button"
        onClick={() => onChange('DoubleCommand')}
        disabled={disabled}
        className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
          disabled
            ? 'cursor-not-allowed bg-gray-400/40 text-white'
            : theme === 'dark'
              ? 'bg-white/10 text-white hover:bg-white/15'
              : 'bg-black/10 text-gray-900 hover:bg-black/15'
        }`}
      >
        {doubleCommandLabel}
      </button>
      <button
        type="button"
        onClick={() => onChange('')}
        disabled={disabled}
        className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
          disabled
            ? 'cursor-not-allowed bg-gray-400/40 text-white'
            : theme === 'dark'
              ? 'bg-white/10 text-white hover:bg-white/15'
              : 'bg-black/10 text-gray-900 hover:bg-black/15'
        }`}
      >
        {clearLabel}
      </button>
      <button
        type="button"
        onClick={onSave}
        disabled={disabled}
        className={`rounded-xl px-3 py-2 text-xs font-medium transition-colors ${
          disabled
            ? 'cursor-not-allowed bg-teal-500/50 text-white'
            : 'bg-teal-500 text-white hover:bg-teal-600'
        }`}
      >
        {saveLabel}
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
  if (lower.length === 1) return lower.toUpperCase();

  return key.length ? key[0].toUpperCase() + key.slice(1) : null;
}

function FlatSelect({
  theme,
  value,
  options,
  onChange,
}: {
  theme: ThemeMode;
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const current = options.find((opt) => opt.value === value) ?? options[0];

  return (
    <div ref={rootRef} className="relative">
      <button
        onClick={() => setOpen((prev) => !prev)}
        className={`flex min-w-[120px] items-center justify-between rounded-xl border px-3 py-2 text-sm transition-colors focus:outline-none focus:ring-2 focus:ring-teal-500 ${
          theme === 'dark' ? 'border-gray-700 bg-gray-800 text-gray-100 hover:bg-gray-700' : 'border-gray-200 bg-gray-50 text-gray-900 hover:bg-gray-100'
        }`}
      >
        <span>{current?.label}</span>
        <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.12 }}
            className={`absolute right-0 top-[calc(100%+6px)] z-50 min-w-[140px] overflow-hidden rounded-xl border shadow-sm ${
              theme === 'dark' ? 'border-gray-700 bg-gray-900' : 'border-gray-200 bg-white'
            }`}
          >
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`flex w-full items-center justify-between px-3 py-2 text-left text-sm transition-colors ${
                  value === opt.value
                    ? 'bg-teal-500 text-white'
                    : theme === 'dark'
                      ? 'text-gray-200 hover:bg-gray-800'
                      : 'text-gray-700 hover:bg-gray-50'
                }`}
              >
                <span>{opt.label}</span>
                {value === opt.value ? <Check className="h-4 w-4" /> : null}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
