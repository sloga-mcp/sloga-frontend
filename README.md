<div align="center">
<h1>
  Sloga Frontend
  
  [![Stars](https://img.shields.io/github/stars/sloga-mcp/sloga-frontend?style=flat-square&logoColor=white)](https://github.com/sloga-mcp/sloga-frontend/stargazers)
  [![Forks](https://img.shields.io/github/forks/sloga-mcp/sloga-frontend?style=flat-square&logoColor=white)](https://github.com/sloga-mcp/sloga-frontend/network/members)
  [![Pull Requests](https://img.shields.io/github/issues-pr/sloga-mcp/sloga-frontend?style=flat-square&logoColor=white)](https://github.com/sloga-mcp/sloga-frontend/pulls)
  [![Issues](https://img.shields.io/github/issues/sloga-mcp/sloga-frontend?style=flat-square&logoColor=white)](https://github.com/sloga-mcp/sloga-frontend/issues)
  [![Contributors](https://img.shields.io/github/contributors/sloga-mcp/sloga-frontend?style=flat-square&logoColor=white)](https://github.com/sloga-mcp/sloga-frontend/graphs/contributors)
  [![License](https://img.shields.io/github/license/sloga-mcp/sloga-frontend?style=flat-square&logoColor=white)](https://github.com/sloga-mcp/sloga-frontend/blob/main/LICENSE)
</h1>
The web client powering <b><a href="https://app.sloga.gg">Sloga</a></b> — game chat for guilds and clans, with opt-in end-to-end encrypted DMs and calls. Built with <a href="https://www.solidjs.com/">Solid.js</a> 💖.<br/>
Downloads for Windows, Linux and Android: <a href="https://sloga.gg">sloga.gg</a><br/>
<sub>A fork of the upstream Revolt/Stoat web client, <a href="./LICENSE">AGPL-licensed</a>.</sub>
</div>
<br/>

## Development Guide

Before contributing, read the [code style guidelines](./GUIDELINES.md).

Before getting started, you'll want to install:

- [Git](https://git-scm.com/install/)
- [mise-en-place](https://mise.jdx.dev/getting-started.html)

Then proceed to setup:

```bash
# clone the repository
git clone --recursive https://github.com/sloga-mcp/sloga-frontend client
cd client

# update submodules if you pull new changes
# git submodule init && git submodule update

# install all packages
mise install:frozen

# build deps:
mise build:deps

# or build a specific dep (e.g. stoat.js updates):
# pnpm --filter stoat.js run build

# customise the .env
cp packages/client/.env.example packages/client/.env

# run dev server
mise dev

# run all CI checks locally
mise check
```

Finally, navigate to http://localhost:5173.

### Using the official backend

By default, the client connects to a backend running on the same host (localhost).

If you want the client to connect to the official hosted backend instead, open the .env file at /packages/client/.env and comment out the local URL varaibles like this:

```env
# connect to a local Sloga instance
#VITE_API_URL=http://localhost:14702
#VITE_WS_URL=ws://localhost:14703
#VITE_MEDIA_URL=http://localhost:14704
#VITE_PROXY_URL=http://localhost:14705

```

When these variables are not set, the client automatically falls back to the official backend. (See [env.ts](packages/client/components/common/lib/env.ts).)

## Deployment Guide

### Build the app

```bash
# install packages
mise install:frozen

# build dependencies
mise build:deps

# build for web
mise build

# ... when building for Sloga production
mise build:prod
```

You can now deploy the directory `packages/client/dist`.

### Routing Information

The app currently needs the following routes:

- `/login`
- `/pwa`
- `/dev`
- `/discover`
- `/settings`
- `/invite`
- `/bot`
- `/friends`
- `/server`
- `/channel`

This corresponds to [Content.tsx#L33](packages/client/src/index.tsx).
