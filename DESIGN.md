# Video RSI 设计规范

日期：2026-10-09。状态：已确认目标与范围的设计草案，待与执行计划一并评审。本文不代表软件已实现。
仓库：https://github.com/geekjourneyx/video-rsi

## 1. 已确认的目标

先证明创作实际价值：帮助个人技术创作者从一个明确简报得到可录制的视频方案，减少选择和修改时间。通过本人盲选比较人工方案、单轮与多轮输出。首版不声称提高播放量、预测爆款或实现递归自我进化。

用户已确认：TypeScript + Pi；多模型、多轮次、CLI；先本人盲选；Python 和官方 RRSI 均非首版依赖。先把结果做可信、可比较，再决定是否扩大自动化范围。

## 2. 第一性原理与架构选择

创作质量需要人的判断；传播效果还受曝光和平台分发影响。LLM 自评分只能用于建议排序。只有在同一简报、可比预算下比基线更有用，多轮流程才值得保留。

| 路线 | 适用目标 | 取舍 |
|---|---|---|
| TS + pi-ai + 普通函数 | 固定多模型创作流程 | 首版采用；最少运行时与隐式控制流 |
| 增加 pi-agent-core | 模型自主选择工具和下一步 | 仅有明确自主检索任务后引入 |
| 官方 RRSI + Python | 官方算法复现或复杂 Harness 搜索 | 独立研究选项；未排期、无预留空目录 |

首版一个 npm 包、单进程、顺序请求，不建 monorepo、多服务或通用调度框架。Node >=22.19.0、ESM、TypeScript strict、npm lockfile、Vitest。macOS/Linux 是验收平台。运行依赖仅 pi-ai、Zod；JSON 配置，原生 parseArgs/fs/crypto；不引入 YAML、数据库、向量库或 Web UI。Pi 包当前为 @earendil-works/pi-ai，实施前确认发布版本和许可证并锁定；不要照搬旧包名或旧全局 API。

Node floor 验收说明（2026-10-09）：lockfile 中 Rollup 的 Linux x64 可选开发依赖 `@napi-rs/lzma-linux-x64-gnu@1.5.1` 声明 `^22.20 || ^24.12 || >=25`。它不是运行依赖；在 Node 22.19.0/npm 10.9.3 的隔离目录实际执行 `npm ci --offline` 时被跳过，随后完整 typecheck/build/test 与离线安装验收全部通过（175 个测试）。Node >=22.19.0 保持不变；CI 持续在 Linux/macOS 核验该 floor，不能因新的必需依赖而默默提高最低版本。

## 3. 首版功能和非目标

输出标题、封面文案与构图建议、完整脚本、前 5/10 秒内容、事实来源映射、评审理由、Top 3。时长仅由简报目标与字数估计提示，不能保证实际口播秒数。

固定流程：生成一批候选 → 独立模型批判 → 可选下一轮修改 → 合并各轮合格候选 → 给出排序建议。默认 1 轮、3 候选；多轮必须显式配置，避免默认增加成本。每轮 1 次 writer、1 次 judge，无自动重试或修复循环。

首版不做：自动联网 research、图片生成、视频分析/剪辑、虚拟用户模拟、行为概率/播放量预测、平台算法复刻、自动发布、自动策略晋升、RRSI/Dream 搜索。用户可输入有来源的研究摘录与已有脚本。平台是输入标签和写作语境，不内置虚构推荐权重。

## 4. Unix CLI 协议

```sh
video-rsi create brief.json --config video-rsi.json > candidates.json
video-rsi judge candidates.json --config video-rsi.json > evaluated.json
video-rsi create brief.json --config video-rsi.json --review > evaluated.json
video-rsi report evaluated.json --format markdown > result.md
video-rsi resume runs/<run-id> > result.json
video-rsi replay runs/<run-id> > recorded.json
```

create 默认只有一批生成；--review 执行生成与评审，使用配置 rounds；不带 --review 时 rounds 必须为 1，否则报参数错误。独立 judge 仅评审传入候选一次。report 和 replay 零网络。所有读取 JSON 的命令支持 `-` 表示 stdin。Brief 和 Config 输入（文件或 stdin）最大 1 MiB；judge/report 读取的派生 CandidateBatch/EvaluatedBatch 输入最大 8 MiB，允许合法 Brief 加候选与评审后继续通过管道处理。

stdout 只输出一个完整 JSON（或显式选择的 Markdown），进度/错误去 stderr；不混入 ANSI、模型 token 流或标题。无 TTY 提问、自动开浏览器、隐式安装和隐式网络。--help/--version 不需配置或密钥。通过 shell 和文件组合，不将每一步包装成新 Agent。

全局 --config（默认 ./video-rsi.json）、--runs-dir（默认 ./runs）、--quiet。report --format=json|markdown，默认 json。配置路径相对 cwd；配置内文件路径相对配置目录。预算、轮次和模型都从配置读取，不增加重复的覆盖机制。密钥只通过配置指定的环境变量名读取；不写入文件。

退出码：0 成功；1 内部错误；2 输入/配置错误；3 模型请求/输出错误；4 调用限制或预算停止；5 运行记录损坏/恢复冲突；130 SIGINT；143 SIGTERM。错误 stderr 为一行 JSON，含 code/message/runId（存在时）；debug 堆栈仅显式调试。EPIPE 静默停止派发并结束。成功结果允许 status=needs_review，不等于已经验证内容正确。

## 5. 数据与函数边界

所有业务文件带 schemaVersion:1。src/contracts.ts 定义 Zod schema 并推导类型；不手写重复接口。金额为整数 microUSD；token 用量未知为 null，不能记作 0。日期 ISO 8601。

- Source：id、title、excerpt、可选 url；引用只代表给定出处，不保证出处真实性。
- Brief：schemaVersion、topic、platform、audience:string[]、durationSeconds:{min,max}、sources:Source[]、draft?:string。
- ModelRef：provider、model、apiKeyEnv。
- Config：schemaVersion、models:{writer:ModelRef,judge:ModelRef}、rounds、candidatesPerRound、limits:{maxCalls,maxOutputTokens,timeoutMs,maxEstimatedCostMicrousd:number|null}。
- Candidate：id、round、title、cover:{text,direction}、script、hook5s、hook10s、claims:{text,sourceIds:string[]}[]。
- CandidateBatch：schemaVersion、runId、brief、candidates:Candidate[]。
- Verdict：candidateId、scores:{audience,clarity,consistency,utility}、claims:{index,status:'supported'|'uncertain'|'unsupported',reason}[]、reason。
- EvaluatedBatch：CandidateBatch + evaluation:{kind:'model_judgment',verdicts:Verdict[],topIds:string[],status:'ok'|'needs_review'}。
- CompletionRequest：callId、role:'writer'|'judge'、model:ModelRef、system、input、maxOutputTokens、timeoutMs。
- Completion：text、stopReason:'stop'|'length'|'error'|'aborted'、usage:{inputTokens:number|null,outputTokens:number|null,estimatedCostMicrousd:number|null}、providerRequestId?:string、raw:unknown。
- ModelClient：complete(request:CompletionRequest,signal:AbortSignal):Promise<Completion>。
- RunEvent：schemaVersion、seq、runId、type、at、payload；type 为 started/call_started/call_finished/call_unknown/round_finished/stopped/completed。
- RunRecord：schemaVersion、runId、status:'running'|'interrupted'|'failed'|'limited'|'completed'、manifest、events:RunEvent[]、result?:CandidateBatch|EvaluatedBatch。

schema 限制：Brief/Config 输入最大 1 MiB；派生 CandidateBatch/EvaluatedBatch 输入最大 8 MiB；内部证据文档及单条事件最大 8 MiB；非空字符串；rounds 1–5；candidatesPerRound 1–8；maxCalls 1–20；maxOutputTokens 1–8192；timeoutMs 1000–120000；各评分为 0–4 整数。sources.id 唯一，candidate.id 由程序生成；未知字段拒绝。maxEstimatedCostMicrousd 要么 null，要么正整数。brief.durationSeconds 为 1–300 且 min<=max。judge 输出需恰好覆盖输入候选和每条 claim，不允许重复/新增 ID。report 对候选唯一性、来源引用、评审覆盖及 Top/status 与 verdicts 的一致性进行验证；不一致时报输入错误，不静默重排或修正记录。

## 6. 生成、评审与可信度

writer/judge 的 provider+model 必须不同。独立上下文、隐藏生成者身份和历史分数、确定性打乱顺序；不同模型仍可能共享偏差，因此这不是独立现实证据。

程序检查字段、来源 ID、重复内容；相同标题+脚本 hash 的重复候选只保留最早一条。模型评审四维等权，均分相同按 candidate.id 稳定排序。含 unsupported 的候选不进入 Top；uncertain 可进入但整体 needs_review。没有可推荐项时 Top=[]、needs_review，不凑数。supported 是模型判断，不是自动事实认证。

首轮只读 Brief，后续 writer 可读此前候选及批判；新一轮 judge 看不到此前评分。最终对每个候选使用其独立评审结果排序。输入摘录包在明确数据边界中，不执行其中指令；无任意 shell/file 工具。未来工具能力需要新设计评审。

## 7. 调用与成本

Pi 隔离在 src/model.ts，固定流程无需 Agent Core。使用 Models collection 的 provider/model 查找与 completeSimple，检查 stopReason，不能假设 Promise resolve 就是成功。第一轮接入只支持经 smoke 验证的 OpenAI、Anthropic 两个 API Provider；模型 ID 从配置提供，不在业务逻辑写死型号。可用性和价格以执行时核验为准。

maxCalls 是派发硬上限；maxOutputTokens 映射 Provider 支持的输出上限；timeout/AbortSignal 控制本地等待。所有调用，包括失败尝试，都消耗 call 数。SDK/Provider 自动重试必须在接入验证中查明并关闭，或证明纳入实际尝试计数；无法确认时不能宣称物理请求硬上限。

费用是估算：保存 Pi catalog 报价快照、时间和 usage。maxEstimatedCostMicrousd 非 null 时，每次调用前要求有可用报价和保守预留额（输入按模型 contextWindow、输出按 maxOutputTokens，缓存不预扣优惠）；剩余额不足不派发。开启费用阈值时实际 usage 缺失则保留预留额并停止，避免把未知当免费；未开启费用阈值时记录 unknown，仍受次数上限约束。请求结束后按可用 usage 对账。对于输出/推理计费无法形成保守上界的模型，只允许费用阈值为 null，仍保留调用次数限制。

该预算不能保证供应商账单硬上限；供应商价格变更、隐式计费等由账户配额约束。默认示例 maxCalls=2、maxEstimatedCostMicrousd=null，让用户明确看到费用阈值未开启。schema 校验在任何付费调用前完成。

## 8. 持久化、恢复与回放

runs/<UUID>/ 包含 manifest.json（Brief、脱敏 Config、prompt 快照/hash、软件版本、模型 ID/报价、随机种子）、events.jsonl、calls/<call-id>.json（请求、脱敏原响应、用量）、result.json、lock。

每次派发先 fsync call_started，再请求，原子写调用结果后写 call_finished；最终结果同目录临时文件 fsync+rename，结果成功持久化后才标 completed。JSONL 仅允许截去没有换行的残尾；中部损坏拒绝。一个运行同一时刻只有一个 writer，独占锁；完成/受控退出释放锁。SIGKILL 后仅 resume --recover-lock 在同主机已死 PID 时允许清锁，拒绝活动或异主机锁。

已有完整响应不重复调用；call_started 无响应是 unknown。默认拒绝 resume 并说明可能已收费；--retry-unknown 显式允许再次调用，旧尝试继续占用 call/保守费用预算。resume 固定输入、配置与 prompt 快照，不偷偷采用新版本；改变条件新建 run。SIGINT/TERM 保存部分记录、传递 AbortSignal，取消不证明供应商未计费。

replay 读取和校验已有 result/hash，输出相同结果，绝不调用模型。缺少最终结果返回 5。固定 seed 仅控制本地顺序；云端模型重跑不保证输出一致。无通用任务队列、守护进程或跨机器恢复。

## 9. 本人盲选协议

命令：blind prepare <study.json> --out <directory>；blind record <directory> --pair <id> --choice A|B|tie|neither --reason <text> --edit-minutes <n>；blind summary <directory>。

Study 输入最大 8 MiB（包含派生候选）；blind allocation/review 与单条选择事件各最大 8 MiB。Brief/Config 的默认 1 MiB 上限保持不变。

Study：schemaVersion、seed、items:[{briefId,variant:'manual'|'single'|'multi',candidate:Candidate,productionMinutes:number,runPath?:string}]。同 brief 每种 variant 恰好一个，缺项拒绝。单轮/多轮各选事先约定的 Top 1，不得在盲选结果出来后更换。人工稿在看到模型输出前准备；没有人工稿可改为仅 single/multi 两臂，Study 增加 arms 字段明确列出两臂或三臂，禁止伪造人工基线。

prepare 生成每个 brief 的全部两两比较，左右随机，用无语义 pair ID；review.md 只含统一格式的内容，allocation.json 单独保存映射，selection.jsonl 保存选择。已存在输出目录拒绝覆盖。模型自评、provider、成本、variant、round 均不出现在盲选页。风格仍可能暴露来源，承认这是有限盲法。

选项 tie 表示都可用且无明显偏好，neither 表示都不愿采用；记录后不可覆盖旧结果，误操作追加 supersedes 指向原记录并保留审计。summary 在全部比较完成前拒绝解盲；不给未完成样本假结果。`--supersedes <eventId>` 仅指向同一 pair 当前有效记录的 eventId（保存在 selection.jsonl）；追加保留旧记录，独占锁防止并发覆盖。

`--edit-minutes` 为选中 A/B 方案预计修改时间，tie/neither 必须填写 0 且不计入改稿均值。两两偏好为 `(winsA + ties * 0.5) / (winsA + winsB + ties)`；全部 neither 时为 null。人工制作分钟独立列出；未引用运行或费用未知时费用为 null。引用运行必须完成且候选与已验证结果内容/ID 一致、为 Top 1，single/multi 必须对应实际一轮/多轮 create+review；成本包含该运行的全部尝试，由 hash 校验后的调用证据读取。盲选页简报只展示 briefId 中性参考，Study 不包含完整 Brief 文本。examples/study.json 是格式占位示例，没有真实基线或本人盲选结果。

核心读数：各臂采纳意愿、两两偏好（胜1/平0.5/负0，neither单列并报告覆盖率）、人工预计改稿分钟、生成/制作耗时、模型费用。没有显著性或泛化承诺。多轮与单轮明确标注实际预算；非同预算结果不能用于算法效率优势结论。

先用 6 个真实简报做工具试用，再用下一批 6 个未用于调 Prompt 的简报复核。这个 6+6 是个人工作节奏，不是统计功效保证。工程验收看记录完整与无泄漏；是否采用多轮由用户在第二批解盲后按偏好、时间、成本决定。没有明显收益就保持单轮默认并停止增加 Agent。

## 10. 后续研究门槛

真实发布反馈是独立阶段：先明确平台、观测窗口、指标分母和内容版本关联，建立前瞻实验；本人盲选不能替代观众效果。

只有存在可信评分任务、重复手动调策略的明确成本，并且简单对照不足时，才评估 RRSI。可先用 TS 实现受限策略实验，注明 inspired；官方复现另选 Python。无需现在抽象 Domain 接口。Git worktree 不是数据权限隔离；如果未来自动修改 Harness，holdout 必须与搜索进程隔离且避免反复消费。

Dream 的历史回放不提供未发布候选的真实奖励。世界模型必须在新数据上校准后才讨论。研究方向不自动变成产品依赖。

## 11. 质量纪律

每任务以真实失败场景的测试驱动，RED→GREEN→相关回归→小提交。默认 CI 离线；Provider smoke 显式触发并有费用额度，不拿 fixture 冒充真实调用。打包后安装验收。没有密钥时在线验收标 blocked，不虚报通过。

文档只维护 README、DESIGN、开发计划三份。每个依赖与抽象必须对应当前任务；新增功能先证明现有 CLI 无法组合完成。输出合同、预算和实验记录比覆盖率百分比更重要。
