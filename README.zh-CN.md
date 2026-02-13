# RoseReader

[English](README.md) | [简体中文](README.zh-CN.md)

RoseReader 是一个 vibe-coding 项目：一个简洁的跨平台 EPUB/PDF/TXT 阅读器，核心体验是无限滚动阅读。

## 项目简介

RoseReader 面向希望在本地管理电子书、并获得更流畅阅读体验的用户（尤其是 Linux 用户）。

核心目标：
- 从本地目录快速导入书库
- 提供顺滑的 EPUB 无限滚动阅读
- 提供实用阅读工具（搜索、书签、高亮、笔记）
- 保证阅读状态可持续（进度、历史、统计）

## 主要功能

### 书库与组织

- 将本地目录导入为书库
- 文件夹树导航与管理
- 在文件夹间移动书籍（可选同时移动磁盘文件）
- 自动监听文件系统变化，识别新增/变更书籍

### 阅读体验

- EPUB 无限滚动渲染
- 支持 PDF / TXT
- 书内搜索与目录（TOC）跳转
- 自定义字体、间距、阅读主题
- 划词操作（含快速 Google / Google AI Mode 查询）

### 阅读状态持久化

- 阅读进度、最近阅读时间、完成时间记录
- 书签、高亮、笔记
- 基于文件指纹的“移动书籍状态恢复”
- 设置中支持手动合并移动/重复书籍状态

## 截图

### 主阅读界面

![Main reading view](imgs/屏幕截图_20260213_170601.png)
![Reader controls](imgs/屏幕截图_20260213_170407.png)
![Progress panel](imgs/屏幕截图_20260213_170405.png)

### 嵌套高亮与定位提示

![Nested highlights](imgs/image%203.png)

### 类 CodeMap 的搜索提示

![Search codemap](imgs/屏幕截图_20260213_175358.png)

### 书库搜索

![Library search](imgs/屏幕截图_20260213_175411.png)

### 划词跳转 Google AI Mode

![Selection actions](imgs/屏幕截图_20260213_175722.png)
![Google AI Mode lookup](imgs/屏幕截图_20260213_175730.png)

## 技术栈

- Electron
- Node.js
- `epub2`
- `pdf-parse`
- `pdfjs-dist`

## 安装方式

### Windows

目前 Windows 上最稳定的方式是从源码运行：

1. 安装 Node.js 20+
2. 克隆本仓库
3. 安装依赖

```bash
npm install
```

4. 启动应用

```bash
npm start
```

可选：生成本地 unpacked 包做测试

```bash
npm run pack
```

### Linux

#### 方案 A：源码运行

```bash
npm install
npm start
```

#### 方案 B：Arch Linux（PKGBUILD）

```bash
makepkg -si
```

启动器会导出：

```text
ROSE_DATA_DIR=${XDG_CONFIG_HOME:-$HOME/.config}/RoseReader
```

在 Linux 上，`npm run start` 与打包安装版共享同一个持久化目录，因此进度、书签、高亮、笔记不会分裂。

## 开发

要求：
- Node.js 20+

安装依赖：

```bash
npm install
```

开发运行：

```bash
npm start
```

生成 unpacked 包：

```bash
npm run pack
```

构建 Linux 发行包：

```bash
npm run build
```

## 数据存储

应用数据会持久化在数据目录中：
- `rosereader-data.json`
- `rosereader-data-backup.json`
- `covers/`（封面缓存）

包含内容：
- 书库与书籍
- 阅读进度/历史
- 书签/高亮/笔记
- 设置与统计数据

## 项目结构

- `main.js`：Electron 主进程，负责扫描/导入、持久化、IPC、迁移逻辑
- `index.html`：渲染层 UI、样式与交互逻辑
- `PKGBUILD`：Arch 打包辅助文件

## License

MIT
