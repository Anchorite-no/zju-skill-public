# 凭据与发布安全

`profile.env` 保存 AES-256-GCM 密文；随机密钥单独存入 Windows 凭据管理器、macOS 钥匙串或 Linux Secret Service。旧 KEY=VALUE 文件首次读取时先加密并回读验证，再原子替换，不生成明文备份。凭据库不可用、被锁定或密文损坏时停止，不回退到明文。升级后不要使用旧版本打开已迁移的账号文件。

在交互终端运行 `node scripts/zju.ts profile init --system zju`，按提示输入账号和密码。密码输入不回显，也不放入命令参数。其他系统可选 webvpn、cc98、pta、chaoxing、mail、lab、tyys、buddy；多账号使用 `--index`。自动化程序可通过 `profile init --stdin` 传入字段 JSON，程序不会回显输入。空值清除相应字段。

进程环境变量可以临时覆盖账号，不写入文件；不要在 shell 历史中直接输入真实密码。`.env` 仅保留非秘密运行设置，检测到其中的校园密码时拒绝继续登录，需用新入口配置账号后删除旧项。

此保护针对文件误传和离线复制；同一系统用户仍可访问系统凭据库。换电脑或删除系统密钥后需重新配置。Cookie、会话缓存、下载材料和旧备份仍是敏感本机文件，不得公开。诊断输出对密码、令牌、Cookie 和认证 URL 脱敏。

安装 Gitleaks 8.30.1 后运行 `npm run security` 检查跟踪文件与全部历史；可用 `GITLEAKS_BIN` 或 `git config security.gitleaksPath` 指向本机程序。`git config core.hooksPath .githooks` 启用提交及推送检查。扫描输出始终脱敏，例外仅限按值和路径核验的官方前端公开协议常量。

`npm pack` 会检查实际包文件清单，拒绝开发资料、账号、Cookie、私钥与数据库。开发文档只留在本机忽略目录。GitHub 的旧 PR 引用和缓存不随普通 Git 推送删除，历史清理后还需另行核对。

如真实凭据已公开，先在相应服务撤销或轮换，再处理历史和发布产物。重写历史不能使旧密码失效，也无法回收他人下载的副本。
