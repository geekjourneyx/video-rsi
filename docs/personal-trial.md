# 个人试点操作指南（准备阶段）

当前只准备材料与操作步骤；没有真实人工稿、模型结果或本人选择，第一批试用与第二批复核均待进行。六份 [简报示例](../examples/trial/) 是拟议主题，工程经验/工具实践/趋势观点各两份，**不是已核实的个人经历**。`sources: []` 仅使空白材料可编辑且结构合法，不能作为事实依据；所有者须确认主题、平台、受众、时长，补入核验过的 id/title/excerpt（url 可选），才能开始真实试用。不编造经历、数据或出处。

## 1. 在看模型结果之前固定条件

把材料留在本地 `runs/studies/`（已被 Git 忽略），不要提交真实运行与选择记录。以下命令从仓库根目录执行；先按 README 构建并安装 `video-rsi`。

```sh
mkdir -p runs/studies/batch01/briefs
cp examples/trial/*.json runs/studies/batch01/briefs/
cp examples/video-rsi.json runs/studies/batch01/single.json
cp examples/video-rsi.json runs/studies/batch01/multi.json
```

编辑确认六份简报；用中性 `briefId`（如 b01–b06）另存与主题的对应表。先为全部六份写完人工方案、记录真实制作分钟，再读取任何模型输出。人工方案需包含 Candidate 的 id、round（用 1）、title、cover.text/direction、script、hook5s、hook10s、claims；事实主张填真实 sourceIds。人工稿单独保存，不填入共享 Brief 的可选 draft，避免只让模型臂得到额外基线。没有人工稿时只能预先声明两臂 `arms: ["single", "multi"]`；有人工稿用 `arms: ["manual", "single", "multi"]`，不能事后编造人工基线。

在本地笔记预先写下：臂、六个 briefId、软件版本、prompt/配置快照、模型、运行顺序、预算、选择规则与停止规则。两个模型配置保持完全一致（writer/judge 本身须为不同 provider+model）。第一批比较实际默认的**实用套餐**：single 保持 rounds=1、candidatesPerRound=3、maxCalls=2；multi 只改 rounds=2、maxCalls=4。其余限制保持一致。示例费用阈值为 null，未开启；所有者须在实际付费前确认账户额度与可接受预算。

选择规则固定为完成运行的 `evaluation.topIds[0]`，从 `candidates` 按该 id 复制整个候选；multi 的 Top 1 可能来自第一轮，不能改选第二轮。Top 为空、调用失败/预算停止均记该臂失败；不额外重跑挑好结果。`needs_review` 的 Top 1 必须人工核验；若有事实/来源问题，记失败并写明原因，不替换成 Top 2 或改写成另一个候选。两臂使用同一资格检查。

## 2. 生成并记录每个臂

下面以第一份为例，对六份各执行一次 single 和 multi；真实 API 调用会收费，当前准备阶段没有执行。`--review` 必需，否则 create 不执行多轮评审。

```sh
video-rsi create runs/studies/batch01/briefs/engineering-01.json --config runs/studies/batch01/single.json --runs-dir runs/studies/batch01/model-runs --review > runs/studies/batch01/b01-single.json 2> runs/studies/batch01/b01-single.log
video-rsi create runs/studies/batch01/briefs/engineering-01.json --config runs/studies/batch01/multi.json --runs-dir runs/studies/batch01/model-runs --review > runs/studies/batch01/b01-multi.json 2> runs/studies/batch01/b01-multi.log
```

每次立即记录退出码、起止时间/墙钟耗时、实际人工操作分钟、runId/runPath、Top 1 id、资格检查、失败原因与费用是否已知；结果的 runId 对应 `model-runs/<runId>`。失败也保留日志和运行证据，未知费用填 null。恢复遵循 README，不能把付费重试当成原臂的新成功样本。

手工按 [Study 格式示例](../examples/study.json) 建立 `runs/studies/batch01/study.json`，替换全部占位内容与 seed，明确 arms。每个纳入的 brief 必须具有声明的每臂恰好一条 `{briefId, variant, candidate, productionMinutes, runPath?}`；模型项填绝对 runPath，人工项不填。productionMinutes 为实际制作/操作分钟，墙钟生成耗时另记，不填估计改稿分钟。不能省略模型 runPath 来绕过完成状态/Top 1/轮次核验。

某臂失败导致无法齐备时，该 brief 不纳入这份 Study；单独台账保留全部六个 brief、每臂成败及排除原因。若全部无法成对，不伪造 Study，直接报告失败。按声明的臂数：两臂最多 6 对，三臂最多 18 对（每种臂比较最多 6 对）。

## 3. prepare → 人工 record → summary

```sh
video-rsi blind prepare runs/studies/batch01/study.json --out runs/studies/batch01/blind
# 仅阅读 blind/review.md；allocation.json 含来源映射，全部选择前不要打开。
video-rsi blind record runs/studies/batch01/blind --pair <pair-id> --choice A --reason '填写真实理由' --edit-minutes <预计分钟>
video-rsi blind summary runs/studies/batch01/blind > runs/studies/batch01/summary.json
```

pair-id 取自 review.md，对每对人工记录一次；choice 可为 A/B/tie/neither。tie 表示都可用且无明显偏好，neither 表示都不愿采用，这两者 edit-minutes 必须为 0。A/B 的 edit-minutes 仅估计选中方案的修改时间。误操作用 `--supersedes <eventId>` 追加更正（eventId 取自 selection.jsonl）。未完成全部比较时 summary 拒绝解盲；风格可能暴露来源，盲法有限。

一起报告台账与 summary：每臂失败数/6、每种比较完成数/6及排除原因、胜/负/tie/neither、已知/未知费用、生成墙钟时间、人工制作时间与选中方案预计改稿分钟。CLI 偏好分母为胜+负+tie，neither 单列；tie/neither 不进入改稿均值。summary 只覆盖纳入的完整 brief，失败臂的费用/耗时须从台账补充，不能只报成功样本偏好。六个简报不能证明显著提升、泛化或传播收益。

## 4. 下一批与停止规则

固定 prompt、模型、预算、Top 1 与资格规则，再用下一批六个**新**简报（仍每类两份，不用于调 prompt）重复同一流程；第一批和第二批分开报告全部失败/排除项。第二批目前待进行。事先由所有者写下可接受成本、耗时、改稿时间及怎样算明确实用收益；不得代填人类偏好或阈值。第二批解盲后由所有者决定是否采用多轮；多轮没有明确实用收益时保留单轮默认，停止增加编排复杂度。

1 轮 3 候选与 2 轮 3 候选分别最多 2/4 次调用，是预算不同的套餐比较，不能解释为搜索效率优势。若要讨论效率，另行预先声明同预算对照（例如 single 1 轮×6 候选 vs multi 2 轮×3 候选，两臂 maxCalls=4、同模型/输出上限/费用阈值）；相同候选数或调用上限并不等于相同实际 token/费用，须完整报告并确认预算可比。不要把不同实验合并成一个结论。

只有确需真实传播反馈时才另设计发布/观测阶段；只有可信评测及手工策略调整成本成立时才重新评估 RRSI。此试点没有“必须进化”的成功条件。
