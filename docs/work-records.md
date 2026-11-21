# 工作记录命令索引

本页说明仓库工作记录的操作入口；用户提供目标和决定，无需手动编辑 JSON。Agent 先用 `pnpm work guide <action>` 导航，已有任务用 `pnpm work context <task> <action>`。动作包括 start、resume、implement、verify、deliver、handoff、archive；判断协议见[协调协议](coordination.md)。

| 用途                 | 命令                                                                       |
| -------------------- | -------------------------------------------------------------------------- |
| 操作导航与任务上下文 | `work guide <action>`、`work context <task> <action>`                      |
| 建档或复用、更新     | `work ensure --stdin`、`work update <task> --stdin`                        |
| 任务与资料查询       | `work status`、`work check`、`work read`、`work documents`、`work changes` |
| 核对变更             | `work sync <task> <reason>`                                                |
| 正式检查与人工证据   | `work run`、`work evidence`                                                |
| 交付与交接           | `work deliver <task> --stdin`、`work handoff`、`work receive`              |
| 保留历史             | `work archive`                                                             |

以下命令均由 Agent 在仓库根用 `pnpm work` 调用，结构化请求经 stdin 输入；示例中的 `api-probe` 代表实际任务 ID。工具不读取个人 Skill 目录，不常驻调度。

## 创建任务

先从[资料导航](index.md)核对相关需求和现行契约，再从[成果索引](tasks/index.md)核对相关结果。按[开始任务](coordination.md#开始任务)确定目标、范围、授权、验收和停止条件，用 `pnpm work ensure --stdin` 建档或复用。`requirement` 的 source、实际唯一标题 section 和稳定 key 关联公共需求；同一 source/key 生成稳定任务 ID，换会话或重试不新建任务。section 更正保留身份，需根据实际正文和当前 revision 更新。

开发能力声明 `plan.result={prd,key}`，维护、检查或演练明确声明 `result:null`；不确定时先核对，不能凭空制造开发成果。`scope` 是允许写入的范围，`sources` 是实际遵循的需求资料，`inputs` 按需要说明依赖；验收项包含稳定 ID、可观察判据和 automated／review／behavior 方法。工具核对结构，目标与授权由实际任务确定。

以下是传给 `pnpm work ensure --stdin` 的最小请求形状，章节、内容和授权均须替换成实际任务；它不授权示例中的修改：

```json
{
  "requirement": {
    "source": "docs/foundation.md",
    "section": "当前范围与来源",
    "key": "example-review"
  },
  "plan": {
    "goal": "实际目标",
    "result": null,
    "scope": ["docs/foundation.md"],
    "sources": ["docs/foundation.md"],
    "norms": { "paths": ["docs/foundation.md"], "reason": "本次实际规范影响" },
    "authorization": "当前用户实际授权",
    "nonGoals": ["本次不做的事项"],
    "acceptance": [{ "id": "review", "criterion": "实际可观察判据", "method": "review" }],
    "nextAction": "当前已授权的下一步",
    "stopCondition": "实际停止条件"
  }
}
```

ensure 成功表示记录已创建或读取，不表示现场和授权已通过。确认当前契约、依赖与现场后，用 update 进入 `C1_IMPLEMENTATION`。源码范围触发 `quality-review`；开发成果和适用的维护声明 `plan.norms` 并执行 `norms-review`。必要规范正文随实现进入受验提交。旧记录和原件保留，续接不批量迁移或改写历史接受。

## 核对与同步

用 `status` 查找任务，结合当前目标和公共来源确认对象；列表不对每项执行现场验收。`context <task> <action>` 展示当前任务的有界视图和动作导航，`check <task>` 核对记录和证据。省略内容按返回的读取入口及 `--offset`、`--limit` 展开；分页期间若记录有变化，重新读取以免混用不同现场。退出成功、阶段、检查结论和人类接受是不同事实。

`pnpm work documents` 只读列出已登记的资料与成果入口，`work changes <prd> [key]` 按需查看变更，`work read-result <prd> [key]` 读取公共成果。记录有效但派生 report 缺失或过期时，read-result 仍可读取成果；若仅有这类导航漂移，documents 仍列出有效记录与结果，同时报告 issue 并返回非零。无效记录或孤儿产物仍拒绝，不能因同时存在导航漂移而忽略。资料身份、登记和归属见[资料导航](index.md#增长与归属)。实际来源及候选中的提交需要人工核对，目录摘要不代替需求审阅。

任务的 `revision` 是非负整数，每次实际写入递增，用于拒绝过期更新。旧记录缺此字段时按 0 看待，首次正常编辑接入现行结构；只读不迁移。`contractRevision` 同样是非负整数，只在目标、范围、授权、验收、规范等实质契约发生变化时递增；notes、nextAction 和阶段变化不改变它。update 使用当前 revision；冲突时先核对原意、授权和现场，再提交新的合法更新，不能机械覆盖。

例如将以下请求传给 `pnpm work update api-probe --stdin`，其中 revision 数值和文本须根据当前上下文替换；阶段变更须同时提供当前 nextAction：

```json
{
  "revision": 1,
  "reason": "已核对授权、依赖及实际现场，开始实施",
  "stage": "C1_IMPLEMENTATION",
  "plan": { "nextAction": "实施当前已授权的修改" }
}
```

正式候选为 `{commit, contractRevision}`，其中 commit 是完整 Git 对象 ID，指向干净工作区当前提交。提交或实质契约变化后是不同候选；旧的字符串候选只保留历史含义，不猜测它对应哪个 Git 提交，也不把旧通过自动套用到新候选。任务 ID 的稳定哈希与候选身份不同。

发现变化先看实际 diff 和相关资料，判断范围、授权、依赖、验收与必要规范是否改变。更新真实变化，提交并确认工作区干净后，用 `work sync` 说明审阅理由并固定正式候选；脏工作区不能通过 sync 固定候选。同步不制造证据或接受，旧原件、失败与未知保留。仅当所需材料和环境经实际核对适用时，才能作为新候选人工复核的依据。

## 实施命令

建档、核对授权并进入 `C1_IMPLEMENTATION` 后，可直接使用适当的编辑器、脚本或命令执行授权内修改。先确认写入责任和影响范围；代码冲突时隔离工作区，不覆盖其他人的改动。命令失败后的修改须检查，不自动回滚或同步。

计划、实施和本地调试允许工作区有改动。脏工作区可直接运行测试获得反馈，但该反馈不是正式候选的取证。正式 `run`、`evidence`、prepare 和 complete 前必须核对干净工作区并使用正式候选；忽略的 `.work` 保存个人记录与原件。提交是正式候选的一部分，是否提交仍遵循当前任务授权。

### 命令占用与异常恢复

同一任务的 CLI 写操作使用任务锁，防止并发写入；不同任务的记录不因此互相锁定。revision 与原子比较并交换用于拒绝过期写入，任务锁不是代码工作区隔离，也不拦截任意宿主文件编辑。读取原件和其他任务可以继续，不能用删除活动锁绕开在途操作。

`work run` 在启动前落盘 pending，再执行并保存实际 argv、候选、环境、退出码、信号和日志；取消时转发信号并等待子进程与执行组结束。取消或未确认结束不能记作通过。异常中断留下未结算观察或占用时，先核对实际进程、日志与状态；确认无在途写入后再按工具提示恢复，保留原件和未知，不因后来的成功抹去旧问题。

## 记录证据

进入 `C1_EVIDENCE_PENDING` 并给出真实下一步后，在干净的提交候选上收集证据。自动检查、人工审查、业务观察和人类接受分别判断；静态检查不能代替测试、业务验证或接受。

`work run <task> <criterion>` 按验收声明的命令取证；`work run <task> <criterion> -- <argv ...>` 可执行定向补测。也可使用 `--stdin` 传入下列对象，其中 `command` 和 `conditions` 均可省略；提供 conditions 时三项均须填写实际条件。省略 command 时使用验收声明的 argv：

```json
{
  "command": ["pnpm", "test", "tests/foundation/plugin.test.ts"],
  "conditions": {
    "dependencies": "实际依赖及安装状态",
    "configuration": "实际配置和核对依据",
    "external": "实际外部服务条件或明确无外部依赖"
  }
}
```

每次执行先在任务状态登记一条指向原始日志的 pending，再记录实际 argv、候选、环境、退出码或信号。进程组确认收束后，原位更新该条并为完整日志自动计算 checksum；无法确认收束时日志仍可能增长，不计算 checksum，读取显示 pending，任务占用保留。checksum 有助检测原件变化，但不证明观察真实或覆盖充分。后续失败、缺失、损坏或未知不能被先前通过掩盖，补测通过也不能自动替代完整检查。run 实际执行一次；下述人工或 CI 覆盖登记本机执行次数为 0。

GitHub Actions 的记录须写明实际受验提交 SHA、run URL、结果与日志；远端门禁、完整测试和业务观察分别报告。CI 摘要不是原件，必须保留可核对的日志或链接。运行时环境、依赖、外部条件和未覆盖项按实际事实说明，不保存凭据。

人工审查和业务观察保存在忽略的 `.work/tasks/<task>/evidence/`，每份原件有唯一写入者，内容说明实际操作者、范围、环境、动作、结果和限制。原件使用独立普通文件，不用符号或硬链接别名，不改写在途日志或已登记的原件；新观察另存。缺少身份的旧原件不能被自动贴上当前候选并当作通过；新候选需要重新观察，或说明旧事实如何支持本次人工复核。原件完整性检查不证明其语义正确。

普通 review／behavior 原件用该验收项的初稿生成 `mio-evidence` 代码块，按返回的 `page.next` 展开并保存全部文本到独立 evidence 文件：

```sh
pnpm work read api-probe evidence-draft review
```

初稿预填完整 candidate、contract 和 criterion，result 初始为 pending；保留工具给出的完整合同并填写非空 observation 和实际结果，正文记录操作者、范围、环境与限制。不自行重组合同，也不能将缺合同的旧原件贴成当前通过。登记原件的命令形状如下，路径、验收 ID 与摘要均须替换：

```sh
pnpm work evidence api-probe review .work/tasks/api-probe/evidence/review.md '实际观察与限制'
```

源码任务在 `quality-review` 中按[验证与接受](coordination.md#验证与接受)实际审阅算法成本、未使用的公共函数／方法和已有实现复用，记录范围、依据、反证及限制；不适用说明理由，缺项或未执行保持 pending。开发成果及适用维护在 `norms-review` 中对账需求与方案、现行规范和已接受成果。分别用 `pnpm work read <task> quality-draft`、`pnpm work read <task> norms-draft` 读取未完成初稿；按返回的 `page.next` 展开并保存全部文本到 evidence 文件。工具预填当前候选和完整合同，人工填写实际观察和结论后，按上面的 evidence 命令登记对应验收 ID 的原件，不手写每页哈希。规范正文必须在受验代码提交中，而不是交付后补写。

### 增量验证与同输入复用

交付前须有覆盖 `pnpm check` 的当前有效结论。可使用当前候选的 GitHub Actions 全量结果，或人工核对可信的全量基线、基线到当前提交的实际 diff、受影响入口和消费者、真实定向增量、环境适用性、缺口及目标覆盖关系。基线的提交、运行链接和日志必须可核对；每次增量执行保留自己的原件。核对环境变化及原有失败／未知，不能用无关成功覆盖它们。

人工复核形成的是覆盖判断，不是命令执行：执行次数为 0 时如实记录 0，不冒充重跑，也不自动传递其他任务的通过。完整覆盖复核可以更新当前结论，但须具体解释原有失败或未知如何处理，历史原件不删除。只在人工说明旧观察仍适用的依据后引用它；改变提交或契约都不能仅因内容看似相同自动继承通过。若缺少可靠基线、影响无法界定、环境或检查入口变化使原覆盖依据失效，或集成失败无法定位范围，由 GitHub Actions 执行全量，结果未取得前保持 pending。

覆盖自动验收项时，用实际自动验收 ID 生成预填候选和合同的 `mio-coverage` 初稿，并按分页保存完整原件：

```sh
pnpm work read api-probe evidence-draft checks
```

填写实际 reviewer、source、scope、environment、uncovered、assessment 和 result 后，用上面的 `work evidence` 命令登记该自动验收 ID。`mode` 可为 `manual` 或 `ci`；CI 记录还须提供 `remoteExecution`，写明实际远端 run URL／标识，source 保留提交 SHA、结果和日志引用。两种覆盖记录的本机 `executionCount` 均为 0；它不否认 CI 的远端执行，也不替代对实际日志和覆盖范围的人工核对。

## 交付命令

可验收开发能力使用注册 PRD 身份和稳定 result key。全部必需原件与当前干净候选匹配、三方对账完成后，`work deliver <task> --stdin` 的 prepare 冻结成果草稿在任务状态中并返回不透明 `draftId`。草稿供实际审阅，不等于接受。候选或证据变化后重新核对；维护、检查和演练不生成公共业务成果。

prepare 请求形状如下，revision 取当前 context，locations 须是受验提交中的实际公共文件；其他内容填写真实结果：

```json
{
  "action": "prepare",
  "revision": 1,
  "title": "实际完成能力",
  "locations": [{ "path": "src/actual-entry.ts", "purpose": "实际入口及职责" }],
  "outcomes": "实际完成范围",
  "verification": "实际验证、环境与结论",
  "limitations": "未覆盖范围与限制"
}
```

返回包含 `revision`、`draftId`、`draft` 和 `readyForAcceptance`；保存并审阅返回的草稿，不手算草稿摘要或候选标识。人类明确接受后向同一命令提交 complete，例如：

```json
{
  "action": "complete",
  "revision": 2,
  "draftId": "从 prepare 返回值复制",
  "acceptance": {
    "candidate": { "commit": "从 prepare 草稿复制", "contractRevision": 0 },
    "statement": "人类对实际结果的明确接受意见",
    "reference": "可核对的接受来源或对话定位"
  }
}
```

revision 和 candidate 数值仅示意；complete 使用当前 revision、prepare 返回的 draftId 和草稿中的完整 candidate 对象。返回包含 `completed`、`replayed`、`revision`、`report`（记录路径、key 和 candidate）及 `files`，仍需读回结果。

人类明确接受该结果及候选后，complete 提交真实接受声明和可核对的来源，并引用已审阅的 draftId。工具核对候选、原件和草稿，取得短暂发布锁，依次原子写入所属 PRD 的 `complete/records.json`、派生的 `complete/report.md` 和任务状态；不能覆盖兄弟成果或其他任务结果。`records.json` 是唯一公共事实，report 是导航；既有历史接受对象和候选字符串保留，新接受使用候选对象。

发生中断时核对实际记录、导航与任务状态。各恢复路径仍核对当前契约、checkpoint 与原件；同一 draft、完整 result 已精确发布时可幂等读回并补状态，不倒推 revision，未完成恢复须使用当前 revision。report 只可补缺失内容、替换候选 C 中原有的 report，或保留与当前记录一致的派生字节；人工改写的 report 拒绝覆盖。不放行任意脏的 `docs/` 改动，不覆盖其他人的结果，也不重写已接受事实。详见[工具边界](engineering/work-tooling.md#写入恢复与保留)。

独立编辑与发布冲突时保留实际编辑内容，任务保持待接受。发布会先确认存储支持所需的原子替换，再更新公共成果。中断留下的文件先按[工具边界](engineering/work-tooling.md#写入恢复与保留)核对，恢复时仍使用同一 draft 和当前候选。

区分受验代码提交 C 和发布结果产生的文档提交 D：记录接受的是 C；complete 生成的公共文件随后按授权提交为 D，D 不能冒充已接受的代码候选。公开摘要不替代代码、日志和人工原件，同 key 的新候选须重新验证并取得真实接受。

## 发送与接收

`pnpm work handoff <task>` 准备个人交接材料，发送方先核对并提供固定提交、契约、授权范围、下一步和必需原件的实际取得方式。摘要、路径或候选标识本身不传输文件；共享前审阅并遵守已有授权。

接收方取得实际代码和原件后，用 `work receive` 接收，核对候选、依赖和当前授权；不自动继承通过或接受。公共成果可用作定位和了解已接受范围的线索，不能恢复作者的代码或私人证据。缺失材料保持未知，按授权重新取证。

## 归档命令

`pnpm work archive <task> <reason>` 按需保留已完成、取消或暂缓的个人记录和原件，不删除文件，也不表示验收通过。重开须核对新目标与授权，使用当前 revision 显式更新；旧历史不自动成为新任务。

## 记录结构

任务记录保存成员和工作区、稳定任务身份、计划、阶段、revision、contractRevision、候选、证据、notes、归档及交付状态。`revision` 管理并发；`contractRevision` 标识实质契约；`candidate` 绑定正式提交与契约。证据保存验收项、结果、候选、原件路径与自动 checksum，原始日志和人工观察留在 `.work`。

公共协议、需求、源码、测试和检查配置入库；个人任务状态、原件、待审草稿、handoff 和 inbox 位于忽略的 `.work`。公共 CI 不读取个人记录，也不替代本人的工作核对。缺少原件或代码时不能推断它们已经恢复。
