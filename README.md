# Pi Studio

Pi Studio 是为 macOS 设计的 [Pi](https://pi.dev/) 桌面工作区。在同一个项目目录里，你可以继续终端里的 Pi 对话，查看它读写了哪些文件，再打开一个本地终端验证结果。

## 项目理念

**换一个界面，不换一套 Pi。** Studio 通过原生 RPC 连接你已经安装的 Pi，不内置另一套代理，不要求注册 Studio 账号，也不迁移已有对话。模型、认证和会话历史仍由 Pi 管理。这不代表推理一定离线：消息是否发送给外部服务，取决于你在 Pi 中选择的模型和插件。

**让判断依据可见，把决定留给使用者。** 阅读时可以折叠工具输出，需要核对时再展开原始细节。例如，子代理提出的问题会显示为卡片；把指导意见放进草稿，并不等于已经回复或批准。

## 安装（Apple Silicon）

1. 先按 [Pi 官网](https://pi.dev/) 的说明安装 Node.js 版 Pi。打开终端运行 `pi`，确认可以选择模型、完成认证并正常对话。Studio 不会替你安装或升级 Pi。
2. 在本仓库的 **Releases → Assets** 下载 `Pi-Studio-1.0.2-mac-arm64.dmg`。`Source code` 是源码归档，不是安装包。
3. 打开 DMG，将 **Pi Studio.app** 拖到 **Applications**，弹出磁盘映像，再从“应用程序”打开。该版本未做开发者签名或 Apple 公证；macOS 可能会阻止首次打开。请先核对发布页的 SHA-256，无需关闭系统安全保护。

可在下载目录运行以下命令，将输出与发布说明逐字比对：

```sh
shasum -a 256 Pi-Studio-1.0.2-mac-arm64.dmg
```

## 第一次使用：读懂一个项目

1. 点击左栏 **Add workspace**，选择一个你愿意交给 Pi 访问的本地项目目录。
2. 点击该工作区旁的 **+ → New conversation**，输入「请阅读 README，告诉我这个项目如何启动，先不要修改文件」。展开对话中的工具记录，核对 Pi 实际读了什么。
3. 要验证某条命令，选择 **+ → New terminal**。终端使用本地 shell，会实际执行你输入的命令；它是临时的，不是 Pi 的会话历史。
4. 下次打开同一工作区，从左栏选择已有对话即可继续。找不到 Pi 时，先在终端检查 `command -v pi`，再到 **Preferences → About** 核对 Studio 识别的 CLI 路径和版本。

## 从源码运行

需要 macOS、Node.js **22.19 或更新版本**（推荐 24）、npm，以及同一安装中的 Pi CLI 和可导入的 SDK。克隆仓库并进入项目根目录，然后运行：

```sh
npm ci
npm run dev
```

```sh
npm run typecheck  # 类型检查
npm test           # 单元测试
npm run build      # 生产构建
npm run package    # 在 dist/ 生成当前架构的未签名 .app，不会安装
```

应用代码位于 `src/`，跨进程共享类型位于 `packages/shared/`，运行资源和构建脚本分别位于 `resources/` 和 `scripts/`。安装包仅作为 Release 附件分发，不纳入源码历史。

## 贡献与许可

欢迎通过 Issue 报告问题，请附 macOS、Pi Studio 和 Pi 的版本，以及能复现问题的最短步骤。不要上传 API 密钥、完整会话或未经脱敏的项目文件。修改代码前可先运行上述类型检查和测试。

由 YM 开发，OpenAI 的 GPT 模型辅助，基于 [justhil/pi-app](https://github.com/justhil/pi-app)（`703a170`），界面设计参考 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。项目使用 [MIT 许可证](LICENSE)；随附第三方组件的许可声明保留在 `resources/` 中。
