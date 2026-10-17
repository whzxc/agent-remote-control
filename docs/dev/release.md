# 发布维护

[开发](development.md) · [安装](../zh-CN/installation.md)

公开源码与产物位于 whzxc/agent-remote-control。Git tag 定义正式版本，GitHub Releases 保存安装包、更新包、latest.json、Homebrew Cask 和校验和。不发布公共 npm 包。推送、打发布标签、上传与公开 Release 前必须取得用户授权。

## 构建与签名准备

本地发布使用 Apple Silicon Mac、Node.js 24.12+、Rust、完整 Xcode 26+、uv、npm 依赖和已登录的 gh。Windows 与 Linux 产物由工作流构建；Linux 包覆盖 x86_64/aarch64。

Updater 使用独立 Minisign 私钥，必须对应 desktop/tauri.conf.json 的公钥。读取优先级：

1. TAURI_SIGNING_PRIVATE_KEY：私钥内容或已有文件路径。
2. TAURI_SIGNING_PRIVATE_KEY_FILE：已有私钥文件。
3. `~/.tauri/agent-remote-control.key`。

加密密钥另用 TAURI_SIGNING_PRIVATE_KEY_PASSWORD。密钥放仓库外，脚本只读，不生成、搬移或输出。普通 desktop:build 可不带 updater 密钥；release 和 dry-run 都要求它。

macOS 正式包（desktop:build，包括 debug 构建）、release、dry-run 和 release:stage 固定使用个人自签名证书 `Local Connector Self Signed`，SHA-1 指纹为 `DCE238666578502CF7DE81A7B4D5E835A186BC60`。无需设置 APPLE_SIGNING_IDENTITY；如设置，只接受该证书名或指纹。签名按指纹选择，缺少原证书及私钥、指定 ad-hoc 或其他证书时立即失败，不自动选择钥匙串中的公司 Team。产物检查同时校验 Desktop、Core 和 screen helper 的证书与 identifier，stage 拒绝其他身份的包。

证书私钥保存在仓库外的钥匙串中。换构建机必须安全导入同一份证书及私钥；重新生成同名证书不能保持授权身份。正式包启用 hardened runtime，不使用 Apple 公证或时间戳，并清除子进程环境中的其他 APPLE_* 凭据。自签名不等于 Developer ID 或公证，首次安装仍可能被 Gatekeeper 拦截，操作见安装指南。开发入口 npm run dev / npm run build 保留独立的显式 APPLE_SIGNING_IDENTITY 配置，未设置时使用 ad-hoc。

完整 CI 发版的 macOS runner 从 GitHub Secrets `ARC_MACOS_CERTIFICATE_P12`（原证书及私钥的 PKCS#12 文件，经 Base64 编码）和 `ARC_MACOS_CERTIFICATE_PASSWORD` 导入临时钥匙串；导入后按固定指纹检查，结束时删除临时钥匙串。维护者需单独安全配置这两个 Secret；工作流不会生成新证书，缺失时失败。不要把证书私钥、导出文件或密码提交到仓库。Updater Minisign 密钥与上述系统代码签名证书相互独立。

Bundle identifiers：正式 App 为 com.whzxc.agent-remote-control，开发包加 .dev，Core 加 .core，Swift helper 加 .screen。更换身份后检查系统权限，不能把 updater 签名当作系统代码签名。

## 本地检查与构建

```sh
npm run check
npm run check:format
npm test
npm run desktop:build
npm run check:package
```

直接 Cargo 构建/测试后运行 npm run cache:prune。产物只留在构建目录，构建不替换本机安装。检查包内版本、签名、图标、无 Node/npm 运行时及 updater 验签。跨平台验收分别记录，不把 macOS 构建成功当作 Windows/Linux 运行成功。

## 发布命令

取得授权后，在干净且不落后于远端的 main 执行：

```sh
npm run release
# 已完成对应检查时：
npm run release -- --skip-tests
# 指定新版本：
npm run release -- --version X.Y.Z
# 交给完整 CI 构建：
npm run release -- --ci --version X.Y.Z --skip-tests
```

流程检查签名、工作区、分支和 gh 权限，获取远端 main/标签，依据上一公开版本选择新版本，在当前功能提交构建。默认运行 npm test。ARC_BUILD_VERSION 向前端、Core、Desktop 和安装器注入版本；源码中的 0.0.0 保持不变。

产物整理到唯一 release-artifacts/v<version>-<suffix> 目录，生成 latest.json、release-notes.md、Cask 和 SHA256SUMS.txt。发布说明从上一正式 tag 到当前提交生成；上一 tag 必须是祖先。完成验签后在当前提交打 tag，原子推送 main/tag，上传草稿，再公开。

已有 tag 必须指向同一源码。草稿可按相同版本补传，公开版本不可覆盖；源码改变后使用新版本。不要生成只改版本号的提交，也不保留源码 CHANGELOG。

## 演练与分阶段操作

```sh
npm run release -- --dry-run
```

演练构建并生成发布文件，不提交、打 tag、推送或上传，也不自动运行测试。它仍需 updater 私钥和固定的 macOS 自签名证书，不执行 Apple 公证。演练链接使用选择的版本；正式发布需用目标版本重建。

stage/finalize 用于已有产物的整理、验签和汇总；参数以 tooling/release.mjs 为准。缺失平台产物先补齐，再公开完整清单。最新下载、manifest 中的平台 URL、签名和嵌入版本必须一致。

## 旧标识升级提示

从旧标识版本首次发布 ARC 身份时，release.mjs 检查上一公开 tag 的状态目录定义，将一次性手工迁移命令加入发布说明；后续 ARC 到 ARC 发布不重复附加。命令只供用户执行，产品与安装器不自动迁移，不添加兼容 alias。

说明要求用户先关闭旧版登录启动并退出应用，再移动正式、开发、预览状态目录及 XDG 配置目录，维护者另移动 updater 私钥，随后安装新版。目标目录存在时不覆盖。Windows 用户手动移动 LOCALAPPDATA 下对应目录，清理旧版登录项并重新启用新版；macOS 根据系统提示重新授权屏幕录制、辅助功能、完全磁盘访问和登录项。

跨身份更新后，必须从新安装重新读取连接与权限状态。macOS、Windows 安装器注册表/可执行名称与 bundle identity 均使用新名称，旧安装由用户按发布说明处理。

macOS 旧应用备份优先保存为归档，避免可被系统发现的同名 `.app` 副本持续参与身份解析。必须保留展开副本时，核对并注销其 LaunchServices 注册，重新注册当前安装版；不删除备份或修改 TCC 授权。遇到系统开关与 helper preflight 不一致时，先核对授权写入的 bundle id 和系统日志中的请求主体、写入进程，不通过读取旧授权来覆盖 preflight。完整退出系统设置；只有日志确认系统授权提示进程保留旧身份时才针对性重启该进程，再由用户授权并回读验证。普通同身份更新不执行这套清理。

## 发布回读

核对 tag/源码 SHA、工作流结果、公开资产、SHA256SUMS、updater 签名、latest.json 与内嵌版本。再按授权范围做安装版启动、连接、真实客户端工具与任务验收。源码构建、公开产物和已安装应用分别确认；未执行的层面明确说明。不要在仓库保存私人路径、账号、密钥、Tunnel 身份、真实任务或验收过程记录。
