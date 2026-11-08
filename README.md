# dsh-github-top10

一个 DeepSeek Harness 插件：注册 `fetch_github_top10` 工具，调用 GitHub 公共 Search API 取星标最高的前 10 个仓库，格式化为 Markdown 周报表格。

- 纯 Host Plugin，不是 Skill；入口导出 `apply(ctx)`
- 依赖服务：`tools`（`export const inject = ['tools']`）
- 无需认证，未认证限流 **10 次/分钟**，一周跑一次完全够用

仓库：<https://github.com/okuki777/top-10>

```powershell
git clone https://github.com/okuki777/top-10 "dsh-github-top10"
```

> 下文用 `<插件绝对路径>` 指代本目录。路径含空格时，所有命令里**必须加引号**。

**最快上手（三步）**

```powershell
cd "<插件绝对路径>"
npm install                    # 装编译期依赖（只需一次；仅当你改代码时才需要）
npm run build                  # 编译 src → lib
dsh web --patch "<插件绝对路径>\cordis.dev.yml" --port 3099 --no-open
# 浏览器打开终端打印的 URL，新开对话说：调用 fetch_github_top10，把返回的 Markdown 原样贴出来
```

> 只是**接收别人做好的包**、不打算改代码，就跳过前两步——见第 9 节。

---

## 0. 整体概述

**一句话**：每次调用，它把「GitHub 上星标最多的前 10 个仓库」整理成一张可以直接贴进周报的 Markdown 表格。

**它解决的麻烦**：想看"现在最火的仓库有哪些"，要么手点 GitHub Trending（只有当天趋势、不给星标总数），要么自己拼 Search API 的 query 再逐条抄成表格。这个插件把「查询 → 取前 10 → 清洗 → 排版」固化成一次工具调用。

**它是怎么"描述"前十的**：

| 表格列 | 数据来源与处理 |
|---|---|
| 排名 | API 已按星标降序返回；排名按**实际输出顺序**连续编号（跳过的脏数据不占号） |
| 仓库 | `full_name` 作为链接文字，`html_url` 作为地址 |
| 描述 | `description`：压平换行 → 按 **Unicode 码点**截断 80 字 → 补 `…` → 转义 `\|` |
| 星标 | `stargazers_count`，用 `Intl.NumberFormat('en-US')` 加千位分隔符 |
| 语言 | `language`，为 `null` 时显示 `—` |

**整体数据流**：

```
模型 / 用户
   │  调用 fetch_github_top10（可带 format）
   ▼
工具体 execute()                                   ← src/index.ts
   │  GET api.github.com/search/repositories
   │      ?q=stars:%3E1000&sort=stars&order=desc&per_page=10
   │      （证书链不被信任时，并入系统根证书重试一次）
   ▼
规范化 10 条：{ rank, name, url, description, stars, language }
   │
   ▼
canonical value { format, markdown, count, repos }  ← 受 output.schema 强制校验
   │
   ▼
output.render()  → 一段 Markdown 文本（或 JSON 文本）
   │
   ▼
模型 / 用户看到表格
```

**设计上的三个取舍**

1. **只取前 10**：固定 `per_page=10`，不翻页、不做分页聚合——周报只需要头部。
2. **不认证**：省掉 token 管理，代价是 10 次/分钟；一周一次完全够用。
3. **不调用 LLM**：工具体只做确定性工作（取数、清洗、排版）。"这周有什么看点"这类判断留给上游模型，避免把易过期的规则硬编码进代码。

---

## 1. 它对外提供什么

工具名：`fetch_github_top10`

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `format` | `'markdown'` \| `'json'` | 否 | `markdown` | `markdown` 出周报表格；`json` 出结构化条目 |

返回的 Markdown 长这样：

```markdown
## GitHub 星标 Top 10 · 周报（2026-11-08）

> 数据源：GitHub Search API（`stars:>1000`，按星标降序取前 10）；未认证调用 Search API 限 10 次/分钟。

| 排名 | 仓库 | 描述 | 星标 | 语言 |
| ---: | --- | --- | ---: | --- |
| 1 | [codecrafters-io/build-your-own-x](https://github.com/codecrafters-io/build-your-own-x) | Master programming by recreating your favorite technologies from scratch. | 560,920 | Markdown |
```

规范化规则：

- 描述：压平换行 → 按 **Unicode 码点**截断 80 字（中文/emoji 不会被切坏）→ 补 `…` → 转义 `|`
- `description` / `language` 为 `null` 时统一显示 `—`
- 星标数用 `Intl.NumberFormat('en-US')` 加千位分隔符
- 缺 `full_name` 或 `html_url` 的条目直接跳过（不输出 `undefined`），排名按实际输出连续编号

工具体只返回 canonical value `{ format, markdown, count, repos }`，模型看到的文本由 `output.render` 投影——这是 dsh 的工具契约（`output` 是强制的），不是可选项。

---

## 2. 目录里每个文件干什么

| 文件 | 谁读它 | 作用 | 什么时候需要动 |
|---|---|---|---|
| `src/index.ts` | 你、`tsc` | **唯一的源码**：工具定义、取数、规范化、渲染、TLS 回退 | 改工具行为时只改这里 |
| `lib/index.js` | **dsh Loader** | `tsc` 编译产物，纯 JS。实际被加载的就是它 | 不要手改；改完 `src` 后重跑 `npm run build` |
| `package.json` | dsh / pnpm / npm | 包身份 + `dsh.bundle.patch` 指针 + `main`/`exports` + peer + 脚本 | 改版本、改包名；**`peerDependencies` 那条别删**（见第 8 节） |
| `patches/bundle.yaml` | dsh（安装后） | bundle patch：向组合树 `insert` 一行 `id: github-top10` / `name: dsh-github-top10` | 加 `config`、改行 id、临时 `disabled: true` |
| `cordis.dev.yml` | dsh（仅 `--patch` 时） | 本地调试覆盖层，把 `./lib/index.js` 以 file URL 挂进树；**不随包分发** | 只想试、不想安装时 |
| `tsconfig.json` | `tsc` | 编译配置：`strict` + `erasableSyntaxOnly` + `NodeNext` + `outDir: lib` | 一般不用动 |
| `.gitignore` | git | 忽略 `node_modules/`；**`lib/` 故意不忽略**（它是分发的产物） | 一般不用动 |
| `package-lock.json` | npm | 锁定编译期依赖 | 随 `npm install` 更新，应提交 |
| `LICENSE` | 人 | MIT | 分发时必须带上 |
| `README.md` | 人 | 本文件 | 行为变了就同步 |
| `node_modules/` | `tsc`、Node | 编译期依赖（typescript / @types/node / dsh-tools） | **不发包**，见第 9 节 |

> `src/` 与 `cordis.dev.yml` 不在 `package.json` 的 `files` 里，所以发布/安装时不会带出去，包保持干净。

---

## 3. 怎么用：三种方式

### 方式 A — 不安装，直接试（`--patch`）

```powershell
dsh web --patch "<插件绝对路径>\cordis.dev.yml" --port 3099 --no-open
```

- 打开终端打印的 `http://127.0.0.1:3099/?token=...`，新开对话，说：「调用 fetch_github_top10，把返回的 Markdown 原样贴出来」
- **不写** `package.json`、不写 `dsh.profile.bundles`；关掉进程就完全消失
- 若 3099 被占：`--port 0` 让系统挑
- 只想干跑看组合树、不启动服务：

```powershell
dsh --profile web --patch "<插件绝对路径>\cordis.dev.yml" --dump-config
# 期望看到：# == <插件绝对路径>\cordis.dev.yml
#             - id: github-top10-dev
#               name: file:///D:/<...>/dsh-github-top10/lib/index.js   （空格被编码为 %20）
```

一次性跑、不开 GUI：

```powershell
dsh headless --patch "<插件绝对路径>\cordis.dev.yml" "调用 fetch_github_top10（format 用 markdown），把返回的 Markdown 原样打印出来。"
```

### 方式 B — 装进 profile（永久）

```powershell
dsh plugin --profile web add "<插件绝对路径>"
```

然后**重启** `dsh web`。安装后会写：

- `~/.dsh/profiles/web/package.json`：新增 `"dsh-github-top10": "link:<本目录>"`
- 同文件 `dsh.profile.bundles`：追加 `dsh-github-top10`（**自动追加，不用手改**）
- 组合树里出现 `patches/bundle.yaml` 声明的那一行

装好之后，每次启动 `dsh web` 都会带这个工具，不需要 `--patch`。

### 卸载

优先用 GUI 的「插件」页，或 `plugin_manager` 的 `remove_bundle`——它会按「从 `dsh.profile.bundles` 移除 → 卸载运行时贡献 → pnpm remove」的顺序执行。

命令行 `dsh plugin --profile web remove dsh-github-top10` 只做到 pnpm remove，还需要手动把 `dsh.profile.bundles` 里的 `dsh-github-top10` 删掉，否则下次启动会报一条 bundle 被跳过的诊断。

---

## 4. 命令速查

| 命令 | 用途 | 副作用 |
|---|---|---|
| `npm install` | 装编译期依赖（typescript / @types/node / dsh-tools 的类型与运行期副本） | 写 `node_modules/`、`package-lock.json` |
| `npm run build` | `tsc` 编译 `src/index.ts` → `lib/index.js` | **覆盖** `lib/index.js` |
| `npm run typecheck` | 只做类型检查，不产出 | 无 |
| `dsh ... --dump-config` | 打印组合树，不挂载任何插件 | 重写 `~/.dsh/profiles/<名>/cordis.yml`（固定常量） |
| `dsh web --patch ...` | 开一个带插件的 GUI（额外端口） | 同上；不持久化 |
| `dsh headless --patch ...` | 一次性跑一个任务并打印结果 | 首次会新建 `~/.dsh/profiles/headless/` |
| `dsh plugin --profile web add ...` | 永久安装 | 写 `~/.dsh/profiles/web/` |
| `dsh --profile web` | 正常启动（已安装时自动带插件） | 无特殊 |

> 关于 `npm install`：若你的 npm 缓存目录不可写（受沙箱、权限或磁盘限制），用
> `npm install --cache <可写目录>` 把缓存指过去即可；正常环境直接 `npm install`。

---

## 5. 改了代码之后要做什么

```powershell
# 1. 改 src/index.ts
# 2. 重编译（必须，Loader 加载的是 lib/index.js）
npm run build
# 3. 重启进程
#    - --patch 调试：关掉窗口重新执行那条命令
#    - 已安装：重启 dsh web
```

`--patch` 加载的是文件 URL，重启即读到新的 `lib/index.js`；已安装的包如果原地改了 `lib/index.js`，结论是**替换已安装包需要重启**才能加载新的 JS generation。

---

## 6. 出错怎么办

| 现象 | 原因 | 处理 |
|---|---|---|
| 终端 `dsh: warning: 1 entry did not activate`<br>`github-top10-dev (...): failed to import` | `lib/index.js` 解析不到依赖 | 跑 `npm install`。`--patch` 直接加载工作区路径时，dsh 的模块拦截层不覆盖它，插件只能用自己目录的 `node_modules` |
| `Cannot find package '@deepseek-ai/dsh-tools'` | 同上 | 同上 |
| `duplicate tool name fetch_github_top10` | `--patch` 的 dev 层和已安装的 bundle 同时生效 | 二选一：装了就别再传 `--patch` |
| `HTTP 403` / `HTTP 429` + 额度重置时间 | 未认证限流 10 次/分钟 | 等一分钟；报错里带 `剩余额度` 与 `额度重置于` |
| `HTTP 401` / `HTTP 404` | 仓库改名或 API 变动 | 一般自愈；持续出现请检查 `SEARCH_URL` |
| 描述出现意外的 `…` | 超过 80 码点被截断 | 预期行为；`repos[].description` 与 `markdown` 一致 |
| 表格里出现 `—` | 该仓库没有描述或没有 `language` | 预期行为 |
| 启动日志说 bundle 被跳过、peers 不满足 | 你的 dsh 版本与插件的 peer 范围不匹配 | 照日志里给出的 `allow-version` 命令执行，或见第 9 节 |

---

## 7. 关于 TLS 证书（为什么代码里有那段回退）

有的机器（例如装了 Steam++ / FastGithub 这类加速器）会改 hosts，把 `github.com`、`api.github.com` 等域名指到 `127.0.0.1`，由本地代理用**自签 CA** 重签证书。那张 CA 只被操作系统信任，不在 Node 自带的 CA 包里，于是 `fetch` 直接报：

```
UNABLE_TO_VERIFY_LEAF_SIGNATURE
```

而 dsh 是用普通 `node` 跑的，不会自动加 `--use-system-ca`——所以这不是测试脚本才有的问题，装进 dsh 一样会失败。插件里的处理是：

1. 第一次请求用默认 CA；
2. 仅在错误码属于**证书链不被信任**（`UNABLE_TO_VERIFY_LEAF_SIGNATURE` / `UNABLE_TO_GET_ISSUER_CERT_LOCALLY` / `SELF_SIGNED_CERT_IN_CHAIN` / `DEPTH_ZERO_SELF_SIGNED_CERT` / `CERT_UNTRUSTED`）时，把 `tls.getCACertificates('system')` 并入 `tls.setDefaultCACertificates(...)`，并重试一次；
3. 只做一次，第二次起不再触发；正常网络环境永远走不到这条分支。

它**只对齐「操作系统本来就信任的根」**：没有 `rejectUnauthorized: false`，不接受过期或域名不匹配的证书。若不想让进程级 CA 集合被改动，可以在启动 dsh 时自己加 `NODE_OPTIONS=--use-system-ca`（此时回退分支不会触发）。

> 在 Node 版本较老、没有 `tls.getCACertificates('system')` 的环境里，这段回退会安全降级（捕获异常后抛原始错误），不影响插件加载。

---

## 8. 打包装箱注意

- Loader 加载的是 `lib/index.js`，所以**必须**先 `npm run build`，且 `lib/` 不能进 `.gitignore`
- `package.json` 的 `dsh.bundle.patch` 必须指向实际存在的 patch 文件；本仓库是 `./patches/bundle.yaml`
- `peerDependencies` 里的 `@deepseek-ai/dsh-tools` **不要删**：当本包以 `link:` 形式安装时，dsh 只根据导入方自己 `package.json` 的 `peerDependencies` 决定是否把该包从 dsh 安装处供给过来；删了会变成 `Cannot find package`
- peer 写成 `^0.1.7-rc.2` 且 `peerDependenciesMeta.optional`：范围满足当前运行时（不会触发 bundle 兼容性闸门被静默跳过），且不会让 pnpm 硬装第二份
- 包名/版本变更后，`patches/bundle.yaml` 里的 `name` 要同步改

---

## 9. 把包交给别人

### 传什么

| 带上 | 不带 |
|---|---|
| `package.json`、`lib/index.js`、`patches/bundle.yaml`、`README.md`、`LICENSE` | `node_modules/`（几十 MB、平台相关、对方不需要） |
| `cordis.dev.yml`（对方可能也想先试再装） | `src/`、`tsconfig.json`、`package-lock.json`（对方不改代码就不需要） |

### 对方要做什么

```powershell
dsh plugin --profile web add "<收到的目录>"
# 然后重启 dsh web
```

**不需要** `npm install`，**不需要**编译，**不需要** node 构建工具链。原因：以 `link:` 形式安装后，本包成为 dsh 的 linked root，dsh 会依据 `peerDependencies` 把 `@deepseek-ai/dsh-tools` 从 dsh 安装处直接供给过来。

（已实测：把不含 `node_modules` 的副本装进一个全新 profile，启动后无任何告警，插件正常激活。）

### 对方最可能踩的坑

**dsh 版本不一致**。peer 范围是 `^0.1.7-rc.2`；对方 dsh 若不是 `0.1.7` 系列，bundle 会被兼容性闸门跳过，启动日志里会打印一条**带确切命令**的提示（形如 `dsh plugin allow-version dsh-github-top10@0.1.0 --dsh-version <对方版本> --accept-risk`），照抄执行即可。

其他两条：对方的 Node 需支持 `AbortSignal.any`（Node ≥ 20.3，实际跟随 dsh 自身要求）；对方若也处于 HTTPS 拦截代理环境，第 7 节的回退会兜住，只需知道 stderr 会出现一行提示。

### 分发形式

- **压缩包**：最省事，把上表「带上」的文件打成一个 zip
- **git 仓库**：本仓库即 <https://github.com/okuki777/top-10>，对方可以
  `git clone` 后按上面的方式安装，或直接
  `dsh plugin --profile web add https://github.com/okuki777/top-10`
  （git 形式的安装本机未验证过；稳妥做法仍是 `git clone` 后传目录或用 zip）
- **npm**：需先占名字（`dsh-github-top10` 是普通包名），`files` 已经把该发的都列全了
