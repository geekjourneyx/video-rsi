# video-rsi

面向技术创作者的本地视频方案 CLI：从简报生成标题、封面建议、口播脚本，再用另一模型提出批判与排序建议。默认单轮、3 个候选；多轮需显式配置。它不预测播放量，不自动核验事实，也不代表已经实现 RRSI。

当前已经实现 CLI、运行记录、恢复/回放及本人盲选。工程测试使用模拟数据；尚无真实双 Provider smoke、本人盲选结果或传播效果验证。**在线验收 blocked：当前没有两家 API key。** npm 包仍为 `private: true` / `UNLICENSED`，所有者选择许可证之前不发布。

## 本地安装与验收

支持 macOS/Linux、Node **>=22.19.0**，ESM。运行依赖只有 `@earendil-works/pi-ai@1.1.0`（MIT）与 Zod。

```sh
npm ci
npm run check
npm pack --ignore-scripts
npm install --global /absolute/path/video-rsi-0.1.0.tgz
video-rsi --help
video-rsi --version
```

`check` 依次运行 typecheck、build 和离线测试。build 会复制 prompt 资产；打包前必须显式构建。包只包含 `dist/`、README、package.json，以及所有者选定后添加的 LICENSE。测试会在仓库以外的临时目录用 `npm install --offline` 安装 tarball，复用 lockfile 的依赖解析，并验证 help、version、report、带 hash 的 replay 和篡改拒绝。测试与打包没有互相调用的生命周期。

仅运行打包验收时，先执行 `npm run build`，再执行 `npm test -- tests/package.test.ts`。指定 `PACKAGE_TARBALL=/absolute/path/package.tgz` 可验收一个已经打包的产物，发布工作流会使用此方式。

## 配置和简报

以下命令需在构建后的仓库 checkout 中执行；npm 包不包含 `examples/` 和 `docs/`。`examples/` 都是格式示例，不是模型效果、人工基线或实验成绩。可离线运行：

```sh
node dist/cli.js report examples/candidates.json --format markdown
cp examples/video-rsi.json video-rsi.json
```

配置结构如下；示例型号来自锁定版本的本地 catalog，服务可用性仍需单独 smoke：

```json
{
  "schemaVersion": 1,
  "models": {
    "writer": {"provider": "openai", "model": "gpt-4.1-mini", "apiKeyEnv": "OPENAI_API_KEY"},
    "judge": {"provider": "anthropic", "model": "claude-sonnet-4-5", "apiKeyEnv": "ANTHROPIC_API_KEY"}
  },
  "rounds": 1,
  "candidatesPerRound": 3,
  "limits": {
    "maxCalls": 2,
    "maxOutputTokens": 2048,
    "timeoutMs": 30000,
    "maxEstimatedCostMicrousd": null
  }
}
```

**默认费用阈值未开启**：`maxEstimatedCostMicrousd: null`。模型费用以整数 microUSD 记录；未知为 null，不能当作免费。开启费用阈值时会在派发前按 catalog 保守预留，未知用量保留预留额并停止；这不是供应商账单硬上限，仍应设置账户配额。失败调用也占用 maxCalls，无自动重试。

只支持 OpenAI/Anthropic，writer 与 judge 的 provider+model 必须不同。未知型号在联网前拒绝；密钥仅通过 `apiKeyEnv` 指定的环境变量提供，不写入配置或运行记录。用你的密钥管理方式设置这两个变量；不要把真实密钥提交到仓库。相对配置路径从当前目录解析，配置内路径相对配置目录。

所有业务 JSON 带 `schemaVersion: 1`，未知字段拒绝。Brief 包含 topic、platform、audience、durationSeconds、带 id/title/excerpt 的 sources，可选 draft；请替换示例材料并核对出处。Brief/Config 输入上限 1 MiB；候选/评审/Study 输入上限 8 MiB。

## 命令和管道

```sh
video-rsi create brief.json --config video-rsi.json > candidates.json
video-rsi judge candidates.json --config video-rsi.json > evaluated.json
video-rsi create brief.json --config video-rsi.json --review > evaluated.json
video-rsi report evaluated.json --format markdown > result.md
cat evaluated.json | video-rsi report - --format markdown
video-rsi replay runs/<run-id> > recorded.json
video-rsi resume runs/<run-id> > result.json
```

create 无 `--review` 只生成一批，此时 rounds 必须为 1；`--review` 每轮调用 writer/judge 各一次。独立 judge 只评审输入一次。若改为 2 轮，需要同时把 maxCalls 提高到至少 4；默认不增加轮次。所有 JSON 输入支持 `-` 表示 stdin；report 默认 JSON，显式 `--format markdown` 才输出 Markdown。report/replay/help/version 不需要配置、密钥或网络。

stdout 只有一个完整结果，stderr 为进度/费用或一行 JSON 错误；`--quiet` 关闭普通诊断。配置默认为 `./video-rsi.json`，运行目录默认为 `./runs`，可用 `--config` / `--runs-dir` 指定。结果成功持久化后才输出，不流式输出模型 token、不交互询问。

| 退出码 | 含义 |
|---|---|
| 0 | 成功；needs_review 仍需人工复核 |
| 1 | 内部错误 |
| 2 | 输入/配置错误 |
| 3 | 模型请求/输出错误 |
| 4 | 调用次数或预算停止 |
| 5 | 记录损坏或恢复冲突 |
| 130 / 143 | SIGINT / SIGTERM |

## 恢复、回放与模型判断

运行目录保存 manifest、prompt/配置快照、模型/报价、seed、事件、脱敏调用证据和结果/hash。已有完整响应不会重新调用；resume 使用原始快照，不接受模型/预算覆盖。若 call_started 没有完整响应，可能已经收费，默认拒绝继续。只有明确愿意再次付费时才使用 `resume ... --retry-unknown`；旧尝试仍占用调用与预算。SIGINT/TERM 会取消本地等待并保存记录，不能证明供应商未收费。

SIGKILL 遗留锁仅在明确传入 `--recover-lock` 且锁来自同主机已死 PID 时可清除；活动或异主机锁拒绝。replay 只验证并读取已存结果，缺少结果或 hash 不符返回 5，绝不调用模型。seed 只固定本地排列；再次调用云模型不保证输出一致。

评审隐藏生成者身份与历史分数，四维等权，稳定排序；unsupported 不进入 Top，uncertain 会使状态成为 needs_review。不同模型可能共享偏差，supported 也只是模型判断；发布前必须人工复核主张、来源与脚本。程序不自动联网 research、不生成图片、不发布视频。

## 本人盲选

先准备真实人工稿（若使用 manual），再预先选定单轮/多轮 Top 1；不要看完盲选结果后更换候选。Study 的每个 brief 需为配置的两臂 single/multi 或三臂 manual/single/multi 各提供一条方案和实际制作分钟。引用 runPath 时，候选必须匹配经过验证的完成运行、Top 1 及实际轮数；不引用运行或费用未知时，费用为 null。

准备真实试用时见 [个人试点操作指南](https://github.com/geekjourneyx/video-rsi/blob/main/docs/personal-trial.md)（指南中的命令和示例适用于仓库 checkout）：提供六份待所有者确认的可编辑简报，以及失败台账、两批复核和继续/停止规则。当前仅准备完成，真实试用与第二批复核待进行。

```sh
video-rsi blind prepare study.json --out blind-study
# 先只阅读 blind-study/review.md；allocation.json 含来源映射，留待解盲。
video-rsi blind record blind-study --pair <pair-id> --choice A --reason '更愿意录制' --edit-minutes 10
video-rsi blind summary blind-study
```

choice 为 A/B/tie/neither，tie/neither 的 edit-minutes 必须为 0。误操作通过 `--supersedes <eventId>` 追加更正，旧记录保留。所有比较完成前 summary 拒绝解盲。盲选页仍可能通过风格暴露来源；个人偏好只说明本人采纳意愿，不能证明观众传播改善。预算不同的单轮/多轮不能用于算法效率优势结论。

## Provider smoke

仅显式执行，不在 PR CI 自动运行：

```sh
npm run smoke:providers -- --config /absolute/path/private-config.json
```

每家一次 64-token 请求和一次受控取消；取消仍可能收费。日志只含版本、型号、状态、用量、报价与调用数。无 key 时状态 blocked、派发数 0、退出码 3。适配器与两家 Pi SDK 均设置 `maxRetries: 0`、`cacheRetention: 'none'`；缓存写入仍出现时，费用记为 unknown 并保守停止费用阈值模式。报价快照不是实时账单保证。

## 将来的 npm 发布

`.github/workflows/publish.yml` 仅响应 GitHub Release 的 published 事件，跳过 prerelease，不响应普通 push/PR。GitHub-hosted Ubuntu、Node 24、npm 11.9.0（满足 >=11.5.1）、环境 `npm`、`contents: read` / `id-token: write`；没有长期 NPM_TOKEN。release tag 必须严格等于 `v` 加 package.version，repository.url 必须匹配此仓库。当前 private/UNLICENSED/缺少 LICENSE 会使就绪检查清楚失败。

所有者准备首次发布时：

1. 选择许可证，添加 LICENSE，修改 package.license，并在批准公开发布后设置 `private: false`；同步 lockfile 元数据。确认仓库公开、包名及 npm 账户权限。2026-10-09 对 video-rsi 的查询曾返回 E404，**不保证名称可用**；首次发布前重新确认。若改用 scope，先确认其所有权并相应调整包名、测试和配置。
2. 新包尚无设置页时，由所有者先通过 npm 的交互登录/2FA 完成一次初始包发布，使用已审查的 tarball；不要向 GitHub 添加长期写 token。bootstrap 也是公开且不可复用同版本的发布，需单独批准，不能把 dry-run 当作完成。随后选择一个未发布的新版本作为首次自动发布版本。
3. 在 npm 包的 Trusted Publisher 设置选择 GitHub Actions：组织/用户 `geekjourneyx`，repository `video-rsi`，workflow filename `publish.yml`（只填文件名），environment `npm`，并允许直接 `npm publish`。GitHub 创建同名环境，可配置所需发布保护。
4. 就实际发布准备完成后再创建 trusted-publisher 配置；当前规则要求 **2 天内首次成功发布**，过期需重新创建。保护版本 tag 与 release 权限，发布和 package.version 一致的稳定 Release。

工作流先运行质量门槛，pack 一次、列出产物、记录 SHA-256，对同一个 tarball 离线安装验收、publish dry-run、重新核对校验和，再以 provenance 发布该 tarball。公共仓库/公共包的 OIDC 发布支持 provenance。dry-run 只能核验包内容，不能证明名称、权限、OIDC 或实际发布成功。**本次没有执行真实发布，也没有验证未配置的 OIDC 身份。**

官方依据：[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)、[初始公开包发布](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/)、[checkout](https://github.com/actions/checkout)、[setup-node](https://github.com/actions/setup-node)。Actions 的 v7 commit 已按官方 tag 在 2026-10-09 核验并固定；维护时重新核验。

详细数据合同与研究边界见 [DESIGN.md](https://github.com/geekjourneyx/video-rsi/blob/main/DESIGN.md)。
