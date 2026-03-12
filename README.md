# PPaste

PPaste 是一个面向 macOS 和 Windows 的本地剪贴板工具。
它常驻菜单栏或托盘，记录文本与图片剪贴板历史，并支持用全局快捷键快速唤起，再将选中的内容直接粘贴回当前输入位置。

## 适用人群

- 经常在聊天、文档、代码编辑器之间复制粘贴的用户
- 希望用键盘和菜单栏快速调用剪贴板历史的用户
- 需要一个本地运行、不依赖云同步的轻量工具的用户

## 核心能力

- 自动记录剪贴板历史
- 点击文本记录后直接粘贴到当前输入位置
- 支持图片剪贴板预览与保存
- 支持菜单栏或托盘、Dock 或任务栏、全局快捷键唤起窗口
- 支持自定义显示快捷键
- 所有数据保存在本机

## 安装

### 直接安装应用

macOS：

1. 打开 `PPaste.app`
2. 将应用拖入 `Applications`
3. 首次启动后按系统提示授予权限

Windows：

1. 运行打包生成的 `PPaste.exe` 或安装包
2. 首次启动后允许应用访问剪贴板
3. 如果要使用自动粘贴，确保系统没有拦截模拟按键

### 从源码运行

```bash
pnpm install
pnpm tauri dev
```

### 从源码打包

```bash
pnpm install
pnpm bundle
```

打包产物默认位于：

- `src-tauri/target/release/bundle/macos/PPaste.app`
- `src-tauri/target/release/bundle/dmg/PPaste_0.0.1_aarch64.dmg`
- Windows 在 Windows 主机上打包时会输出到 `src-tauri/target/release/bundle/msi` 或 `nsis`

## 首次启动

首次启动后，建议按下面顺序完成配置：

1. 启动 PPaste
2. 根据系统授权 PPaste 访问剪贴板和必要的辅助能力
3. 如果要正常读取剪贴板历史，允许 PPaste 在前台读取剪贴板
4. 打开设置页，确认唤起快捷键

如果系统阻止模拟粘贴，PPaste 可以显示历史，但无法把选中内容自动粘贴回当前输入框。

## 日常使用

### 打开 PPaste

可以通过以下任一方式打开主窗口：

- 点击菜单栏或托盘图标
- 点击 Dock 或任务栏中的应用图标
- 使用全局快捷键

### 选择并粘贴一条记录

1. 先把光标放到你要输入的文本框、编辑器或聊天窗口
2. 唤起 PPaste
3. 点击一条文本记录

PPaste 会自动：

1. 将该条内容写入系统剪贴板
2. 关闭自身窗口
3. 向当前前台应用发送一次粘贴操作

macOS 默认发送 `Command + V`。
Windows 默认发送 `Ctrl + V`。

### 搜索历史

在主窗口顶部搜索框中输入关键字即可过滤历史记录。

### 键盘操作

- `ArrowUp` / `ArrowDown`：移动选择
- `Enter`：复制或粘贴当前选中项
- `Escape`：关闭设置层
- macOS: `Command + ,` 打开设置

## 设置说明

### 主题

支持浅色与深色主题。

### 语言

支持中文与英文界面。

### 开机启动

开启后，系统登录时自动启动 PPaste。

### 快捷键绑定

PPaste 的快捷键绑定不是手动输入字符串，而是直接录制按键：

1. 点击当前快捷键显示区域
2. 直接按下你想绑定的组合键
3. 点击“保存”

### 数据状态

设置页会显示：

- 当前记录总数
- 数据库大小
- 本地数据库路径

## 权限说明

### 辅助功能或自动化权限

用于：

- 将选中的文本自动粘贴回当前前台应用

### 剪贴板访问

用于：

- 读取新的文本或图片剪贴板内容
- 维护历史记录

## 数据存储

PPaste 默认把数据保存在本机：

- 数据目录：`~/Library/Application Support/ppaste`
- 数据库：`~/Library/Application Support/ppaste/clips.db`

如果检测到旧版本 `clipspace` 数据目录，PPaste 会在启动时自动迁移到新目录。

## 常见问题

### 点击记录后没有自动粘贴

优先检查：

1. 是否已授予系统所需权限
2. 当前前台应用是否允许粘贴快捷键
3. 选中的是否为文本记录

### 历史为空

优先检查：

1. 是否真的复制过新内容
2. PPaste 是否处于暂停状态
3. 系统是否阻止了应用访问剪贴板

### 菜单栏或 Dock 点击无法唤起

先完全退出 PPaste，再重新打开。
如果仍然无效，重新安装最新版本并再次授权。

## 开发检查

```bash
pnpm build
cargo check --manifest-path src-tauri/Cargo.toml
```

## 发布说明

`v0.0.1` 的 release note 位于：

- `.github/release-notes/v0.0.1.md`

GitHub Actions 会在推送 tag（如 `v0.0.1`）时自动打包并创建 release。
