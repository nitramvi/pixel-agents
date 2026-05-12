<h1 align="center">
    <a href="https://github.com/nitramvi/pixel-agents/discussions">
        <img src="webview-ui/public/banner.png" alt="Pixel Agents">
    </a>
</h1>

<h2 align="center" style="padding-bottom: 20px;">
  The game interface where AI agents build real things
</h2>

[![version](https://img.shields.io/github/v/release/nitramvi/pixel-agents)](https://github.com/nitramvi/pixel-agents/releases)
[![license](https://img.shields.io/github/license/nitramvi/pixel-agents)](LICENSE)

> **OpenClaw Edition** — This fork adapts Pixel Agents to work standalone with [OpenClaw](https://github.com/openclaw/openclaw) instead of requiring VS Code + Claude Code.

---

## OpenClaw Standalone

This edition includes a **standalone server** that connects directly to the OpenClaw gateway, showing your agents as animated characters in a pixel art office — no VS Code or Claude Code required.

### Quick Start

```bash
# 1. Install dependencies
npm install
cd webview-ui && npm install && cd ..

# 2. Build the webview + server
npm run build:standalone

# 3. Set OpenClaw gateway connection
export OPENCLAW_HOST=localhost
export OPENCLAW_PORT=18789
export OPENCLAW_TOKEN=your-gateway-token

# 4. Start the server
npm run start
```

Open `http://localhost:19100` in your browser.

### Docker (recommended)

```bash
docker build -t pixel-agents .
docker run -d \
  -p 19100:19100 \
  -e OPENCLAW_HOST=host.docker.internal \
  -e OPENCLAW_PORT=18789 \
  -e OPENCLAW_TOKEN=your-gateway-token \
  pixel-agents
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `19100` | Server HTTP port |
| `OPENCLAW_HOST` | `localhost` | OpenClaw gateway hostname |
| `OPENCLAW_PORT` | `18789` | OpenClaw gateway port |
| `OPENCLAW_TOKEN` | — | Gateway auth token |

### Config Persistence

Settings (sound, labels, etc.) and office layouts are saved to `~/.pixel-agents/`.

---

## Original VS Code Extension

Pixel Agents also works as a VS Code extension with Claude Code. See the original sections below for VS Code usage.

---


## Requirements

- VS Code 1.105.0 or later
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and configured
- **Platform**: Windows, Linux, and macOS are supported

## Getting Started

If you just want to use Pixel Agents, the easiest way is to download the [VS Code extension](https://marketplace.visualstudio.com/items?itemName=pablodelucca.pixel-agents). If you want to play with the code, develop, or contribute, then:

### Install from source

```bash
git clone https://github.com/pablodelucca/pixel-agents.git
cd pixel-agents
npm install
cd webview-ui && npm install && cd ..
npm run build
```

Then press **F5** in VS Code to launch the Extension Development Host.

### Usage

1. Open the **Pixel Agents** panel (it appears in the bottom panel area alongside your terminal)
2. Click **+ Agent** to spawn a new Claude Code terminal and its character. Right-click for the option to launch with `--dangerously-skip-permissions` (bypasses all tool approval prompts)
3. Start coding with Claude — watch the character react in real time
4. Click a character to select it, then click a seat to reassign it
5. Click **Layout** to open the office editor and customize your space

## Layout Editor

The built-in editor lets you design your office:

- **Floor** — Full HSB color control
- **Walls** — Auto-tiling walls with color customization
- **Tools** — Select, paint, erase, place, eyedropper, pick
- **Undo/Redo** — 50 levels with Ctrl+Z / Ctrl+Y
- **Export/Import** — Share layouts as JSON files via the Settings modal

The grid is expandable up to 64×64 tiles. Click the ghost border outside the current grid to grow it.

### Office Assets

All office assets (furniture, floors, walls) are now **fully open-source** and included in this repository under `webview-ui/public/assets/`. No external purchases or imports are needed — everything works out of the box.

Each furniture item lives in its own folder under `assets/furniture/` with a `manifest.json` that declares its sprites, rotation groups, state groups (on/off), and animation frames. Floor tiles are individual PNGs in `assets/floors/`, and wall tile sets are in `assets/walls/`. This modular structure makes it easy to add, remove, or modify assets without touching any code.

To add a new furniture item, create a folder in `webview-ui/public/assets/furniture/` with your PNG sprite(s) and a `manifest.json`, then rebuild. The asset manager (`scripts/asset-manager.html`) provides a visual editor for creating and editing manifests.

To use furniture from an external directory, open Settings → **Add Asset Directory**. See [docs/external-assets.md](docs/external-assets.md) for the full manifest format and how to use third-party asset packs.

Characters are based on the amazing work of [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack).

## How It Works

Pixel Agents watches Claude Code's JSONL transcript files to track what each agent is doing. When an agent uses a tool (like writing a file or running a command), the extension detects it and updates the character's animation accordingly. No modifications to Claude Code are needed — it's purely observational.

The webview runs a lightweight game loop with canvas rendering, BFS pathfinding, and a character state machine (idle → walk → type/read). Everything is pixel-perfect at integer zoom levels.

## Tech Stack

- **Extension**: TypeScript, VS Code Webview API, esbuild
- **Webview**: React 19, TypeScript, Vite, Canvas 2D

## Known Limitations

- **Agent-terminal sync** — the way agents are connected to Claude Code terminal instances is not super robust and sometimes desyncs, especially when terminals are rapidly opened/closed or restored across sessions.
- **Heuristic-based status detection** — Claude Code's JSONL transcript format does not provide clear signals for when an agent is waiting for user input or when it has finished its turn. The current detection is based on heuristics (idle timers, turn-duration events) and often misfires — agents may briefly show the wrong status or miss transitions.
- **Linux/macOS tip** — if you launch VS Code without a folder open (e.g. bare `code` command), agents will start in your home directory. This is fully supported; just be aware your Claude sessions will be tracked under `~/.claude/projects/` using your home directory as the project root.

## Troubleshooting

If your agent appears stuck on idle or doesn't spawn:

1. **Debug View** — In the Pixel Agents panel, click the gear icon (Settings), then toggle **Debug View**. This shows connection diagnostics per agent: JSONL file status, lines parsed, last data timestamp, and file path. If you see "JSONL not found", the extension can't locate the session file.
2. **Debug Console** — If you're running from source (Extension Development Host via F5), open VS Code's **View > Debug Console**. Search for `[Pixel Agents]` to see detailed logs: project directory resolution, JSONL polling status, path encoding mismatches, and unrecognized JSONL record types.

## Where This Is Going

The long-term vision is an interface where managing AI agents feels like playing the Sims, but the results are real things built.

- **Agents as characters** you can see, assign, monitor, and redirect, each with visible roles (designer, coder, writer, reviewer), stats, context usage, and tools.
- **Desks as directories** — drag an agent to a desk to assign it to a project or working directory.
- **An office as a project** — with a Kanban board on the wall where idle agents can pick up tasks autonomously.
- **Deep inspection** — click any agent to see its model, branch, system prompt, and full work history. Interrupt it, chat with it, or redirect it.
- **Token health bars** — rate limits and context windows visualized as in-game stats.
- **Fully customizable** — upload your own character sprites, themes, and office assets. Eventually maybe even move beyond pixel art into 3D or VR.

For this to work, the architecture needs to be modular at every level:

- **Platform-agnostic**: VS Code extension today, Electron app, web app, or any other host environment tomorrow.
- **Agent-agnostic**: Claude Code today, but built to support Codex, OpenCode, Gemini, Cursor, Copilot, and others through composable adapters.
- **Theme-agnostic**: community-created assets, skins, and themes from any contributor.

We're actively working on the core module and adapter architecture that makes this possible. If you're interested to talk about this further, please visit our [Discussions Section](https://github.com/pablodelucca/pixel-agents/discussions).


## Community & Contributing

Use **[Issues](https://github.com/pablodelucca/pixel-agents/issues)** to report bugs or request features. Join **[Discussions](https://github.com/pablodelucca/pixel-agents/discussions)** for questions and conversations.

See [CONTRIBUTING.md](CONTRIBUTING.md) for instructions on how to contribute.

Please read our [Code of Conduct](CODE_OF_CONDUCT.md) before participating.

## Supporting the Project

If you find Pixel Agents useful, consider supporting its development:

<a href="https://github.com/sponsors/pablodelucca">
  <img src="https://img.shields.io/badge/Sponsor-GitHub-ea4aaa?logo=github" alt="GitHub Sponsors">
</a>
<a href="https://ko-fi.com/pablodelucca">
  <img src="https://img.shields.io/badge/Support-Ko--fi-ff5e5b?logo=ko-fi" alt="Ko-fi">
</a>

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=pablodelucca/pixel-agents&type=Date)](https://www.star-history.com/?repos=pablodelucca%2Fpixel-agents&type=date&legend=bottom-right)

## License

This project is licensed under the [MIT License](LICENSE).
