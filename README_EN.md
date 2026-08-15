# DyCollect

[中文](README.md)

DyCollect — A tool that collects Douyin videos and automatically transcribes the audio into text. It uses a visible persistent browser to read public creator or favorites lists, deduplicates works by ID, downloads videos with audio serially, generates Markdown with a local Qwen3-ASR model, and removes successfully transcribed MP4 files.

Use it only for content you are authorized to access and retain. It does not bypass private, paid, deleted, DRM-protected, live, image-only, or otherwise access-controlled content.

## Quick start

For a first installation, run these steps in order.
### 1. Install prerequisites

You need Node.js 20+, npm, Git, [uv](https://docs.astral.sh/uv/), FFmpeg, and ffprobe.

Windows 10/11 (PowerShell with winget):

```powershell
winget install --id Git.Git -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id astral-sh.uv -e
winget install --id Gyan.FFmpeg -e
```

Ubuntu 22.04/24.04 (Bash):

```bash
sudo apt update
sudo apt install -y git curl ffmpeg
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
curl -LsSf https://astral.sh/uv/install.sh | sh
```

macOS 13+ (Bash, after installing [Homebrew](https://brew.sh/)):

```bash
brew install git node uv ffmpeg
```

Open a new terminal and verify every command:

```bash
node --version
npm --version
git --version
uv --version
ffmpeg -version
ffprobe -version
```

### 2. Get the source and enter the project


```bash
git clone git@github.com:Ham0118/dycollect.git
cd dycollect
```

### 3. Install Node.js dependencies

```bash
npm install
```

### 4. Install the browser

Windows and macOS:

```bash
npx playwright install chromium
```

Ubuntu:

```bash
npx playwright install --with-deps chromium
```

### 5. Prepare transcription and download the model

```bash
npm run setup:model
```

This creates an isolated Python 3.12 environment, installs platform-appropriate PyTorch and Python dependencies, downloads the approximately 1.6 GB `Qwen/Qwen3-ASR-0.6B-hf` model, and verifies its pinned revision and SHA-256.

- Windows/Ubuntu use CUDA when an NVIDIA GPU is detected, otherwise CPU.
- macOS can use CPU or experimental MPS.
- The model is stored in `models/qwen3-asr-0.6b-hf` and Python in `.venv-qwen-asr`; neither is committed to Git.

To override automatic setup:

```bash
npm run setup:model:cpu
npm run setup:model:cuda
```

### 6. Start DyCollect

```bash
npm run dev
```

Startup is successful when:

- the dashboard opens at `http://localhost:5173`;
- the API responds at `http://localhost:3210`; and
- the terminal stays running without repeated errors or an automatic exit.

Press `Ctrl+C` to stop. Other LAN devices can use the collector host's IP address with port `5173` in development.

## Model status and transcription devices

The web app checks model files at startup. New jobs, resumes, and Favorites monitoring are paused when the model is missing or incomplete; history, cancellation, stopping, and deletion remain available. The web app never downloads a model or runs setup commands. Run `npm run setup:model` on the collector host.

Settings → Transcription device offers:

- `Auto`: CUDA, then MPS, then CPU
- `CPU`: widest compatibility but usually much slower
- `CUDA`: NVIDIA GPUs on Windows/Ubuntu
- `MPS`: experimental Metal acceleration on macOS; switch to CPU if an operator is unsupported

Stop Favorites monitoring and let the queue empty before switching. An unavailable explicit selection fails with an actionable error and never silently falls back.

## Production and CLI

```bash
npm run build
npm start
```

Production listens on `http://0.0.0.0:3210` by default and serves both the API and dashboard.

The CLI submits to an already running API and does not start another browser worker:

```bash
npm run cli -- crawl --profile "https://www.douyin.com/user/..." --count 20 --wait
```

Set `DYCOLLECT_URL` to connect elsewhere.

## Data and backups

- SQLite: `data/archive.sqlite3`
- Creator Markdown: `data/<sec_uid>/articles/`
- Favorites Markdown: `data/favorites/articles/`
- Videos retained after transcription failure: the corresponding `work/` directory

Markdown bodies are not stored in SQLite. Back up the complete `data` directory. With the service stopped, reset everything using:

```bash
npm run reset:database -- --yes
```

This permanently removes the database, Markdown, media, and temporary files under `data`.

## Configuration

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | API/production dashboard bind address |
| `PORT` | `3210` | API/production dashboard port |
| `DYCOLLECT_DATA_DIR` | `data` | Data directory |
| `DYCOLLECT_QWEN_ASR_MODEL` | `models/qwen3-asr-0.6b-hf` | Model directory |
| `DYCOLLECT_QWEN_ASR_PYTHON` | platform Python under `.venv-qwen-asr` | Python executable |
| `DYCOLLECT_URL` | `http://127.0.0.1:3210` | CLI server URL |

The selected device is stored in `data/archive.sqlite3` and defaults to `auto`.

## Feishu Wiki sync

Enter a Feishu custom application's App ID and App Secret under Settings. The app needs Wiki read, node creation, and new-document editing permissions and must belong to the target Wiki. The secret stays in local SQLite and is never returned to the browser.

## Troubleshooting

- **Model missing:** run `npm run setup:model`, then click “Check again” or wait for automatic detection.
- **CUDA unavailable:** confirm `nvidia-smi`, run `npm run setup:model:cuda`, restart, and select CUDA.
- **CPU is slow:** expected; prefer CUDA when available.
- **MPS fails:** MPS is experimental. Stop work and switch to CPU.
- **Browser fails:** rerun the Playwright install command; use `--with-deps` on Ubuntu.
- **FFmpeg missing:** verify both `ffmpeg -version` and `ffprobe -version` in the terminal that starts DyCollect.
- **Download/hash failure:** check Hugging Face connectivity and disk space, then move the invalid model directory aside before retrying.

## Monorepo and development

- `apps/web`: React, Vite, and Tailwind CSS dashboard
- `apps/server`: Express, SQLite, Playwright, FFmpeg, and Qwen3-ASR worker
- `packages/shared`: shared frontend/backend types

```bash
npm run check
npm test
npm run build
```

Reproducible issues and pull requests are welcome. Never commit `data`, `.browser`, models, virtual environments, caches, secrets, or personal logs.

## Acknowledgments

Thanks to the  [Linux.do](https://linux.do) community.

## Security, privacy, and license

There is currently no authentication. Other LAN users can operate jobs when the server binds to `0.0.0.0`;

DyCollect is available under the [MIT License](LICENSE). `Qwen/Qwen3-ASR-0.6B-hf` uses Apache-2.0. Model weights are downloaded from a pinned Hugging Face revision and are not included in this repository.
