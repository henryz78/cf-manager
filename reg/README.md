# cf-reg

Cloudflare 批量注册工具，是 [CF Manager](https://github.com/hefy2027/cf-manager) 的配套工具。自动完成注册、邮箱验证、提取 API Key，注册后的账户可直接导入 CF Manager 进行统一管理。

## 安装

安装到当前目录，完成后在当前目录下使用 `./cf-reg` 运行。

```bash
# Unix / macOS / Linux
curl -fsSL https://raw.githubusercontent.com/hefy2027/cf-manager/master/reg/install.sh | bash
```

```powershell
# Windows (PowerShell / CMD)
curl.exe -fsSL https://raw.githubusercontent.com/hefy2027/cf-manager/master/reg/install.bat -o install.bat && install.bat
```

或直接 clone 仓库后进入 `reg/` 目录运行安装脚本：

```bash
git clone https://github.com/hefy2027/cf-manager.git
cd cf-manager/reg
bash install.sh     # Linux / macOS
install.bat         # Windows
```

要求：Node.js >= v20

### 方式二：GitHub Actions 在线运行

> ⚠️ **不建议 Fork 运行**，可能违反 GitHub 条款导致封号，推荐本地部署。

1. Fork [CF Manager](https://github.com/hefy2027/cf-manager) 仓库
2. 进入 **Actions** → **Run cf-reg**
3. 点击 **Run workflow**，输入注册数量
4. 运行完成后在 Summary 查看结果

## 使用

```bash
# Linux / macOS
./cf-reg --count 5

# Windows (CMD / PowerShell)
cf-reg --count 5
```

```bash
# 无头模式
./cf-reg --headless --count 10

# 指定密码
./cf-reg --password mypassword --count 3
```

完成后账号信息导出到 `accounts.json` 和 `accounts.csv`。

## 免责声明

- 不建议使用 Fork 方式运行，推荐本地或自有服务器部署
- 使用 GitHub Actions 运行可能违反 GitHub 服务条款，由此导致的封号风险与本项目无关
- 请遵守 Cloudflare 服务条款，本工具仅供学习研究使用

## 参数

| 参数 | 说明 |
|------|------|
| `-c, --count <n>` | 注册数量 |
| `-p, --password <pwd>` | 固定密码 |
| `-r, --random-password` | 随机密码（默认） |
| `--concurrency <n>` | 并发数（默认 3） |
| `--headless` | 无头模式 |
| `--no-headless` | 显示浏览器 |
| `--screenshots` | 启用截图 |
| `-s, --skip-existing` | 跳过已有账户 |
| `--config <path>` | 指定配置文件 |
| `--help` | 查看帮助 |

## 与 CF Manager 配合

cf-reg 负责批量注册 Cloudflare 账户并提取 API Key，CF Manager 负责将这些账户统一管理（Workers、Pages、DNS、KV、D1、R2、AI 推理、浏览器渲染等）。两者配合形成完整的 Cloudflare 账户管理方案。详见 [CF Manager](https://github.com/hefy2027/cf-manager)。
