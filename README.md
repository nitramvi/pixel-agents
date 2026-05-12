<h1 align="center">
    <a href="https://github.com/nitramvi/pixel-agents">
        <img src="webview-ui/public/banner.png" alt="Pixel Agents">
    </a>
</h1>

<h2 align="center">
  Pixel art office where your OpenClaw agents come to life as animated characters
</h2>

<div align="center">

[![license](https://img.shields.io/github/license/nitramvi/pixel-agents)](LICENSE)
[![release](https://img.shields.io/github/v/release/nitramvi/pixel-agents)](https://github.com/nitramvi/pixel-agents/releases)

</div>

Each agent becomes a character in a pixel art office. They walk around, sit at their desk, and show what they're doing — typing when writing code, reading when searching files, waiting when they need attention.

![Pixel Agents screenshot](webview-ui/public/Screenshot.jpg)

This is an **OpenClaw edition** — adapted from [pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents) (originally a VS Code extension for Claude Code). It runs as a standalone web server that connects to the OpenClaw gateway.

## Quick Start

```bash
npm install
cd webview-ui && npm install && cd ..
npm run build:standalone

export OPENCLAW_TOKEN=your-gateway-token
npm run start
```

Open `http://localhost:19100`.

### Docker

```bash
docker build -t pixel-agents .
docker run -d -p 19100:19100 \
  -e OPENCLAW_TOKEN=your-gateway-token \
  pixel-agents
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `19100` | HTTP port |
| `OPENCLAW_HOST` | `localhost` | Gateway hostname |
| `OPENCLAW_PORT` | `18789` | Gateway port |
| `OPENCLAW_TOKEN` | — | Gateway auth token (required) |

Settings and layouts are saved to `~/.pixel-agents/`.

## Features

- **One agent, one character** — every OpenClaw session gets its own character
- **Live activity tracking** — characters reflect real-time tool usage (writing, reading, running commands)
- **Office layout editor** — design your office with floors, walls, and furniture
- **Speech bubbles** — permission requests and waiting states shown visually
- **Sound notifications** — optional chime when agents complete turns
- **Sub-agent visualization** — spawned sub-agents appear as separate characters
- **Persistent layouts** — saved office designs survive restarts
- **6 diverse characters** — based on [JIK-A-4, Metro City](https://jik-a-4.itch.io/metrocity-free-topdown-character-pack)

## Tech Stack

- **Server:** Node.js, Express, WebSocket
- **Frontend:** React 19, Vite, Canvas 2D, Tailwind
- **Integration:** OpenClaw Gateway WebSocket protocol

## VS Code / Claude Code

For the original VS Code extension version, visit [pablodelucca/pixel-agents](https://github.com/pablodelucca/pixel-agents).

## License

MIT — see [LICENSE](LICENSE). Original work by Pablo De Lucca.
