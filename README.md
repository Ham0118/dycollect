# DyCollect

[English](README_EN.md)

听录机（DyCollect） 采集抖音视频并进行语音转录的软件。它会使用可见的持久化浏览器读取公开主页列表，对作品 ID 去重，串行下载有音轨的视频，通过本地 Qwen3-ASR 生成 Markdown，然后删除转录成功的 MP4。

仅用于你有权访问和保存的内容。不支持或绕过私密、付费、已删除、DRM、直播、图文及其他受访问控制保护的内容。

## 快速开始

首次安装请严格按顺序执行。

### 1. 安装基础工具

需要 Node.js 20+、npm、Git、[uv](https://docs.astral.sh/uv/)、FFmpeg 和 ffprobe。

Windows 10/11（PowerShell，可使用 winget）：

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id astral-sh.uv -e
winget install --id Gyan.FFmpeg -e
```

Ubuntu 22.04/24.04（Bash）：

```bash
sudo apt update
sudo apt install -y git curl ffmpeg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
curl -LsSf https://astral.sh/uv/install.sh | sh
```

macOS 13+（Bash，需要先安装 [Homebrew](https://brew.sh/)）：

```bash
brew install git node uv ffmpeg
```

重新打开终端，然后确认所有工具都能输出版本：

```bash
node --version
npm --version
git --version
uv --version
ffmpeg -version
ffprobe -version
```

### 2. 获取代码并进入项目

```bash
git clone git@github.com:Ham0118/dycollect.git
cd dycollect
```

### 3. 安装 Node.js 依赖

```bash
npm install
```

### 4. 安装浏览器

Windows 和 macOS：

```bash
npx playwright install chromium
```

Ubuntu：

```bash
npx playwright install --with-deps chromium
```

### 5. 初始化转录环境并下载模型

```bash
npm run setup:model
```

该命令会创建独立 Python 3.12 环境、安装匹配平台的 PyTorch 和 Python 依赖、下载约 1.6 GB 的 `Qwen/Qwen3-ASR-0.6B-hf`，并校验固定 revision 与 SHA-256。Windows/Ubuntu 检测到 NVIDIA 时使用 CUDA，否则使用 CPU；macOS 可使用 CPU 或实验性的 MPS。

模型位于 `models/qwen3-asr-0.6b-hf`，Python 环境位于 `.venv-qwen-asr`；两者都不会提交到 Git。自动检测不正确时可强制重新准备运行时：

```bash
npm run setup:model:cpu
npm run setup:model:cuda
```

### 6. 启动项目

```bash
npm run dev
```

满足以下条件即表示启动成功：

- 管理台可以打开：`http://localhost:5173`
- API 可以访问：`http://localhost:3210`
- 终端进程持续运行，没有重复报错或自动退出

按 `Ctrl+C` 停止服务。同一局域网中的设备可通过采集主机 IP 和端口 `5173` 访问开发界面。

## 模型状态与转录设备

网页打开时会检查模型文件。缺失或不完整时会弹出提示并暂停新任务、任务恢复和收藏监听；历史数据查看、取消、停止和删除不受影响。网页不会下载模型或执行系统命令，请在采集主机执行 `npm run setup:model`。

在“设置 → 转录设备”中可以选择：

- `Auto`：依次优先 CUDA、MPS、CPU
- `CPU`：兼容性最高，但通常明显慢于 GPU
- `CUDA`：Windows/Ubuntu 上的 NVIDIA GPU
- `MPS`：macOS Metal 加速，目前为实验性；出现算子错误时请改用 CPU

切换设备前必须停止收藏监听并等待任务队列清空。显式选择不可用设备时程序会报错，不会静默回退。转录固定传递 `zh` 中文提示，模型进程会在服务生命周期内常驻。

## 生产模式

```bash
npm run build
npm start
```

管理台监听 `http://0.0.0.0:3210`。同一局域网中的设备可通过采集主机 IP 访问。当前版本没有密码，因此同一局域网中的用户都可以提交或取消任务。

首次采集或抖音要求验证时，会在采集主机打开可见浏览器。完成登录或人机验证后，在管理台点击“已完成验证，继续”。浏览器状态保存在 `.browser/douyin`。

## 飞书知识库同步

在管理台“设置”页面填写飞书自建应用的 App ID 和 App Secret。保存时会验证凭证，之后服务端会自动获取和刷新 `tenant_access_token`。

飞书应用需要开通知识库读取、创建节点和新版文档编辑权限，并被添加为目标知识库的成员或管理员。配置完成后，可在人物的作品列表勾选已生成 Markdown 的文章，点击“同步飞书”并选择目标知识库。应用凭证和同步记录保存在 `data/archive.sqlite3`，App Secret 不会返回到浏览器。

## CLI

CLI 通过已经运行的 Web API 提交任务，不会启动第二个浏览器 worker：

```powershell
npm run cli -- crawl --profile "https://www.douyin.com/user/..." --count 20 --wait
```

## 数据

- SQLite：`data/archive.sqlite3`
- Markdown：`data/<sec_uid>/articles/`
- 转录失败时保留的视频：`data/<sec_uid>/work/`

Markdown 正文不存入 SQLite；数据库只保存相对路径、元数据和任务状态。转录成功后 MP4 会被删除。

### 重置数据库

停止正在运行的服务后，可将 SQLite 重置为刚初始化的空数据库：

```powershell
npm run reset:database -- --yes
```

该命令会删除整个 `data` 目录中的数据库、Markdown、媒体文件和临时文件，然后按当前 schema 创建全新的空数据库。省略 `--yes` 时脚本只显示警告，不会执行删除。

## Monorepo

- `apps/web`：React、Vite、Tailwind CSS 管理台
- `apps/server`：Express、SQLite、Playwright、FFmpeg 和 Qwen3-ASR worker
- `packages/shared`：前后端共享类型

## 检查

```powershell
npm run check
npm test
npm run build
```

## 配置

| 环境变量 | 默认值 | 用途 |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | API/生产管理台监听地址 |
| `PORT` | `3210` | API/生产管理台端口 |
| `DYCOLLECT_DATA_DIR` | `data` | 数据目录 |
| `DYCOLLECT_QWEN_ASR_MODEL` | `models/qwen3-asr-0.6b-hf` | 模型目录 |
| `DYCOLLECT_QWEN_ASR_PYTHON` | `.venv-qwen-asr` 中的平台 Python | Python 可执行文件 |
| `DYCOLLECT_URL` | `http://127.0.0.1:3210` | CLI 服务地址 |

转录设备选择保存在 `data/archive.sqlite3`，默认是 `auto`。

## 常见问题

- **页面提示模型缺失：**在采集主机执行 `npm run setup:model`，完成后点击“重新检测”或等待自动复检。
- **CUDA 没有被识别：**确认 `nvidia-smi` 正常，再执行 `npm run setup:model:cuda`，重启后到设置页选择 CUDA。
- **CPU 转录很慢：**这是预期行为；有 NVIDIA GPU 时优先使用 CUDA。
- **macOS MPS 失败：**MPS 是实验能力，停止任务后在设置中改用 CPU。
- **浏览器无法启动：**重新执行 Playwright 安装命令；Ubuntu 使用 `--with-deps`。
- **找不到 FFmpeg：**确认 `ffmpeg -version` 和 `ffprobe -version` 能在启动服务的同一终端运行。
- **模型哈希失败：**检查 Hugging Face 网络和磁盘空间；移走无效模型目录后重新初始化，不要覆盖需要保留的文件。

## 贡献、安全与许可证
当前版本没有身份验证。绑定 `0.0.0.0` 时，同一局域网中的其他用户可以操作任务；

DyCollect 使用 [MIT License](LICENSE)。`Qwen/Qwen3-ASR-0.6B-hf` 使用 Apache-2.0；模型权重不包含在本仓库中，由初始化脚本从固定 Hugging Face revision 下载。
