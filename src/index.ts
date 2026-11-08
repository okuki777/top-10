/**
 * dsh-github-top10 — GitHub 星标 Top 10 周报
 *
 * Host 插件（纯 Plugin，非 Skill）：向 tools 注册表注册一个 `fetch_github_top10` 工具。
 * 工具调用 GitHub 公共 Search API，取星标最高的前 10 个仓库，格式化为 Markdown 周报表格。
 *
 * 生效时机：`inject = ['tools']` 让 Loader 等到 tools 服务就绪后才调用 `apply`，
 * 因此 `apply` 内部可以安全地假定 `ctx.tools` 存在。
 *
 * 证书信任：装了 HTTPS 拦截代理/加速器的机器（hosts 把 github 域名指到 127.0.0.1、
 * 本地代理由自签 CA 重签证书）会让 Node 的默认 CA 包校验失败。本插件在遇到这类
 * 信任类错误时，会把操作系统根证书并入 Node 的 CA 集合后重试一次——只对齐
 * 「系统本来就信任的根」，不关闭校验。
 *
 * @module dsh-github-top10
 */

import * as nodeTls from 'node:tls'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'

/** 插件名，与 package.json 一致；出现在 Loader 的诊断里。 */
export const name = 'dsh-github-top10'

/** 必需服务：tools 注册表。 */
export const inject = ['tools']

/**
 * Search API 端点：`q=stars:>1000`，按星标降序，只取 10 条。
 * `>` 在 query 里按 RFC 3986 编码为 %3E（GitHub 两种写法都接受，编码后无需转义）。
 */
const SEARCH_URL =
  'https://api.github.com/search/repositories?q=stars:%3E1000&sort=stars&order=desc&per_page=10'

/** 周报只报告前 N 名。 */
const TOP_N = 10

/** 描述列的截断长度，按 Unicode 码点计（中文/emoji 不会被截断成乱码）。 */
const DESC_MAX = 80

/** 单次 HTTP 请求的超时；工具声明值留一档余量，避免两者同时触发。 */
const FETCH_TIMEOUT_MS = 15_000
const TIMEOUT_MS = 20_000

/** 403/429 时给模型的可执行提示。 */
const RATE_LIMIT_HINT = '未认证调用 Search API 限 10 次/分钟'

/** 输出形态：markdown（默认，人读周报） / json（机读条目）。 */
const FORMATS = ['markdown', 'json'] as const
type Format = (typeof FORMATS)[number]

/** GitHub Search API 中本工具用到的字段；其余字段忽略。 */
interface GitHubRepo {
  full_name: string
  html_url: string
  description: string | null
  stargazers_count: number
  language: string | null
}

/** 一行规范化后的仓库数据，同时也是 canonical value 里 `repos[]` 的元素形状。 */
interface RepoRow {
  rank: number
  name: string
  url: string
  description: string
  stars: number
  language: string
}

/** 工具返回的 canonical value；必须与 `output.schema` 完全对应（additionalProperties: false）。 */
interface Report {
  format: Format
  markdown: string
  count: number
  repos: RepoRow[]
}

/**
 * 插件只需 tools 注册表，因此这里用结构类型描述 ctx，
 * 免得为了 `Context` 再引入一个 cordis 类型依赖。
 */
interface ToolsRegistry {
  /** 注册一个工具，返回注销它的 disposer。 */
  register(definition: ToolDefinition): () => void
}

interface PluginContext {
  readonly tools: ToolsRegistry
  /** cordis 的 effect 登记器：把注册动作产生的清理函数挂到当前 fiber 上（HMR / 卸载时自动注销）。 */
  effect(execute: () => () => void): unknown
}

/** 星标数加千位分隔符，便于扫读。 */
const STAR_FORMAT = new Intl.NumberFormat('en-US')

/** 把任意空白（含换行）压成单个空格并去掉首尾空白：表格单元格不能有换行。 */
function collapse(text: string): string {
  return text.replace(/\s+/gu, ' ').trim()
}

/** 按 Unicode 码点截断，超出时补省略号。 */
function truncate(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length <= max ? text : chars.slice(0, max).join('') + '…'
}

/** 转义 Markdown 表格里的竖线，避免描述把列冲开。 */
function cell(text: string): string {
  return text.replace(/\|/gu, '\\|')
}

/**
 * 把 API 的 items 规范化为表格行。
 * 字段一律做类型收窄，缺字段的条目直接跳过——宁少一行，不输出 `undefined`。
 * @param items - API 返回的 `items` 数组，元素形状不可信。
 * @returns 最多 `TOP_N` 行，`rank` 按实际输出顺序连续编号。
 */
function toRows(items: readonly unknown[]): RepoRow[] {
  const rows: RepoRow[] = []
  for (const raw of items.slice(0, TOP_N)) {
    if (typeof raw !== 'object' || raw === null) continue
    const repo = raw as Partial<GitHubRepo>
    if (typeof repo.full_name !== 'string' || typeof repo.html_url !== 'string') continue
    const description = typeof repo.description === 'string' ? collapse(repo.description) : ''
    rows.push({
      rank: rows.length + 1,
      name: repo.full_name,
      url: repo.html_url,
      description: description === '' ? '—' : truncate(description, DESC_MAX),
      stars: typeof repo.stargazers_count === 'number' ? repo.stargazers_count : 0,
      language:
        typeof repo.language === 'string' && repo.language !== '' ? repo.language : '—',
    })
  }
  return rows
}

/**
 * 渲染 Markdown 周报：标题 + 数据源说明 + 五列表格。
 * @param repos - 规范化后的行。
 * @param fetchedAt - 抓取日期（YYYY-MM-DD）。
 * @returns 可直接粘进周报的 Markdown 文本。
 */
function renderMarkdown(repos: readonly RepoRow[], fetchedAt: string): string {
  const lines = [
    `## GitHub 星标 Top ${TOP_N} · 周报（${fetchedAt}）`,
    '',
    `> 数据源：GitHub Search API（\`stars:>1000\`，按星标降序取前 ${TOP_N}）；${RATE_LIMIT_HINT}。`,
    '',
    '| 排名 | 仓库 | 描述 | 星标 | 语言 |',
    '| ---: | --- | --- | ---: | --- |',
  ]
  if (repos.length === 0) {
    lines.push('| — | 本次未取到仓库条目，可能被限流或 API 结构变化，请稍后重试 | — | — | — |')
    return lines.join('\n')
  }
  for (const repo of repos) {
    lines.push(
      `| ${repo.rank} | [${cell(repo.name)}](${repo.url}) | ${cell(repo.description)} ` +
        `| ${STAR_FORMAT.format(repo.stars)} | ${cell(repo.language)} |`,
    )
  }
  return lines.join('\n')
}

/** 渲染机读形态：只给结构化条目，不含 Markdown 修饰。 */
function renderJson(report: Report): string {
  return JSON.stringify({ count: report.count, repos: report.repos }, null, 2)
}

/**
 * 把一次失败响应翻译成模型可执行的错误信息，并消费掉响应体（避免连接悬挂）。
 * @param response - 非 2xx 的响应。
 * @returns 含状态码、限流余量/重置时间与响应体摘要的一句话。
 */
async function describeFailure(response: Response): Promise<string> {
  const body = (await response.text()).slice(0, 300).trim()
  const parts = [
    `GitHub Search API 返回 HTTP ${response.status}${
      response.statusText === '' ? '' : ` ${response.statusText}`
    }`,
  ]
  if (response.status === 403 || response.status === 429) {
    parts.push(RATE_LIMIT_HINT)
    const remaining = response.headers.get('x-ratelimit-remaining')
    const reset = response.headers.get('x-ratelimit-reset')
    if (remaining !== null) parts.push(`剩余额度 ${remaining}`)
    const resetSeconds = reset === null ? Number.NaN : Number(reset)
    if (Number.isFinite(resetSeconds)) {
      parts.push(`额度重置于 ${new Date(resetSeconds * 1000).toISOString()}`)
    }
  }
  if (body !== '') parts.push(body)
  return parts.join('；')
}

/** 请求头：固定 API 版本、要求 JSON、带一个可辨识的 User-Agent。 */
const HEADERS: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'x-github-api-version': '2022-11-28',
  'user-agent': 'dsh-github-top10/0.1.0',
}

/** 视为「证书链不被信任」的 TLS 错误码（不是过期、不是域名不匹配）。 */
const TRUST_FAILURE_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'CERT_UNTRUSTED',
])

/**
 * 沿 cause 链寻找 TLS 信任类错误码——undici 会把真正的 TLS 错误包在 `fetch failed` 的 cause 里。
 * @param error - fetch 抛出的任意错误。
 * @returns 是否属于证书链不被信任。
 */
function isCertificateTrustFailure(error: unknown): boolean {
  let current: unknown = error
  for (let depth = 0; depth < 5; depth += 1) {
    if (typeof current !== 'object' || current === null) return false
    const code = (current as { code?: unknown }).code
    if (typeof code === 'string' && TRUST_FAILURE_CODES.has(code)) return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

/** 进程级 CA 集合只并入一次，避免重复调用与重复告警。 */
let systemCAsAdopted = false

/**
 * 把操作系统根证书并入 Node 的默认 CA 集合。
 * 这只是补齐「系统已经信任、但 Node 自带包里没有」的根；不设置 `rejectUnauthorized: false`，
 * 也不接受过期或域名不匹配的证书。
 * @returns 是否真的改动了 CA 集合（平台不支持读取系统库时为 false）。
 */
function adoptSystemCertificates(): boolean {
  if (systemCAsAdopted) return false
  systemCAsAdopted = true
  try {
    const merged = new Set(nodeTls.getCACertificates('default'))
    for (const certificate of nodeTls.getCACertificates('system')) merged.add(certificate)
    nodeTls.setDefaultCACertificates([...merged])
    return true
  } catch {
    // 该平台读不到系统证书库时保持原样，让最初的错误照常抛给模型。
    return false
  }
}

/**
 * 请求 Search API：正常环境一次成功；仅在证书链不被信任时补齐系统根证书并重试一次。
 * @param signal - 调用方取消与本地超时合并后的信号。
 * @returns 原始 Response，2xx 判断留给调用方。
 */
async function fetchSearch(signal: AbortSignal): Promise<Response> {
  try {
    return await fetch(SEARCH_URL, { headers: HEADERS, signal })
  } catch (error) {
    if (!isCertificateTrustFailure(error) || !adoptSystemCertificates()) throw error
    console.warn(
      '[dsh-github-top10] Node 默认 CA 不信任该站点的证书链（本机可能有 HTTPS 拦截代理），' +
        '已并入操作系统根证书后重试。',
    )
    return await fetch(SEARCH_URL, { headers: HEADERS, signal })
  }
}

/**
 * 注册 `fetch_github_top10`。
 *
 * 工具体只负责取数与规范化，返回 canonical value；
 * 面向模型的文本由 `output.render` 投影（markdown / json 两种形态）。
 * @param ctx - 已注入 tools 的插件上下文。
 */
export function apply(ctx: PluginContext): void {
  ctx.effect(() =>
    ctx.tools.register(
      defineTool({
        name: 'fetch_github_top10',
        description:
          '抓取 GitHub 上星标最高的前 10 个仓库，格式化为 Markdown 周报表格：' +
          '排名、仓库名（带链接）、描述（截断 80 字）、星标数、语言。' +
          '调用 GitHub 公共 Search API，无需认证，未认证限流 10 次/分钟，适合一周跑一次。',
        parameters: {
          format: {
            type: 'string',
            enum: FORMATS,
            default: 'markdown',
            description: '输出形态：markdown（默认，周报表格）或 json（结构化条目）。',
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              format: {
                type: 'string',
                required: true,
                enum: FORMATS,
                description: '本次实际使用的输出形态。',
              },
              markdown: {
                type: 'string',
                required: true,
                description: 'Markdown 周报全文（无论 format 为何都会生成）。',
              },
              count: {
                type: 'integer',
                required: true,
                description: '实际输出的仓库条数。',
              },
              repos: {
                type: 'array',
                required: true,
                description: '结构化条目，按排名顺序。',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    rank: { type: 'integer', required: true },
                    name: { type: 'string', required: true, description: 'owner/repo。' },
                    url: { type: 'string', required: true },
                    description: { type: 'string', required: true, description: '截断 80 字。' },
                    stars: { type: 'integer', required: true },
                    language: { type: 'string', required: true },
                  },
                },
              },
            },
          },
          render: (_args, value) => [
            {
              type: 'text',
              text: value.format === 'json' ? renderJson(value) : value.markdown,
            },
          ],
        },
        // 只读 GET，无共享可变状态，允许与兄弟调用并行。
        isConcurrencySafe: () => true,
        // 声明协作式超时预算：下面确实把 exec.signal 转发给了 fetch。
        timeoutMs: TIMEOUT_MS,
        async execute(args, exec) {
          const format: Format = args.format ?? 'markdown'
          // 调用方取消 与 本地超时 任一触发即中断。
          const signal = AbortSignal.any([exec.signal, AbortSignal.timeout(FETCH_TIMEOUT_MS)])
          const response = await fetchSearch(signal)
          if (!response.ok) throw new Error(await describeFailure(response))
          const payload = (await response.json()) as { items?: unknown }
          const repos = toRows(Array.isArray(payload.items) ? payload.items : [])
          const markdown = renderMarkdown(repos, new Date().toISOString().slice(0, 10))
          return { format, markdown, count: repos.length, repos }
        },
      }),
    ),
  )
}
