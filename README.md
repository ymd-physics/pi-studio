# Pi Studio

English · [简体中文](README.zh-CN.md)

Pi Studio is a desktop app that brings [Pi](https://pi.dev/) and a terminal into the same workspace.

I wanted a clean, simple interface for working with Pi, with a terminal close at hand whenever I need to run a command.

## Install on Apple Silicon

1. Install the Node.js version of Pi following the instructions at [pi.dev](https://pi.dev/). Run `pi` in your terminal and make sure you can select a model, sign in, and start a conversation. Studio doesn't install or upgrade Pi for you.
2. Under **Releases → Assets**, download `Pi-Studio-1.0.3-mac-arm64.dmg`. The `Source code` downloads are source archives, not installers.
3. Open the disk image, drag **Pi Studio.app** into **Applications**, eject the image, then open Studio from Applications. The app isn't signed with an Apple Developer ID or notarized, so macOS may block its first launch. Verify the download against the SHA-256 checksum on the release page; there's no need to disable system security protections.

To check the download, run this command in your downloads folder and compare its output with the checksum in the release notes:

```sh
shasum -a 256 Pi-Studio-1.0.3-mac-arm64.dmg
```

## Quick start

Studio starts in English. To switch to Simplified Chinese, open **Preferences → Appearance → Language** and choose **简体中文**. No restart is needed. This changes only the Studio interface, not the language of your conversations.

1. Click **Add workspace** in the sidebar and choose a local project directory you're comfortable giving Pi access to.
2. Choose **+ → New conversation** beside the workspace. Try “Read the README and tell me how to run this project. Don't change any files yet.” Expand the tool calls to see what Pi actually read.
3. Choose **+ → New terminal** to try a command yourself. The terminal runs commands in your local shell. It's temporary and separate from Pi's conversation history.
4. Next time you open the workspace, select the conversation in the sidebar to pick up where you left off. If Studio can't find Pi, run `command -v pi` in your terminal, then check the CLI path and version Studio detected under **Preferences → About**.

## What about Linux and Windows?

For now I only ship a macOS installer. My Mac is also the machine I use for testing.

Pi Studio is built on Electron, so in principle it can be built for Linux and Windows too. The current packaging script targets macOS, though, and the integrated terminal relies on zsh. Both may need changes for a port.

If you'd like to try a port, you can give the source code to an agent on your own machine and ask it to help adapt Studio to your platform.

## Run from source (macOS)

You'll need macOS, Node.js **22.19+** (24 recommended), npm, and a Pi installation with both the CLI and an importable SDK. Clone the repository, then run these commands from its root:

```sh
npm ci
npm run dev
```

```sh
npm run typecheck  # check types
npm test           # run unit tests
npm run build      # build for production
npm run package    # create an unsigned .app for your Mac's architecture in dist/ without installing it
```

Application code lives in `src/`, shared types in `packages/shared/`, runtime resources in `resources/`, and build scripts in `scripts/`. Installers are distributed as release assets, not committed to the source tree.

## Contributing and license

Issues are welcome. Please include your macOS, Pi Studio, and Pi versions and the shortest steps that reproduce the problem. Don't upload API keys, complete conversations, or project files that haven't been scrubbed of private information. Before changing the code, you can run the type check and unit tests listed above.

I developed Pi Studio with help from OpenAI's GPT models, drawing on the designs of [justhil/pi-app](https://github.com/justhil/pi-app) (`703a170`) and [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). The project uses the [MIT license](LICENSE); license notices for bundled third-party components are in `resources/`.
