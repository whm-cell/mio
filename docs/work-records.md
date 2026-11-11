# 工作记录命令索引

本页是 Agent 的工具接口，用户无需手动执行这些命令或编辑 JSON。Agent 先 `pnpm work guide <action>`；已有任务用 `pnpm work context <task> <action>`。动作是 start、resume、implement、verify、deliver、handoff、archive。只展开当前动作，不通读本页；判断协议见 [协调索引](coordination.md)。

| 用途                   | 命令                                         |
| ---------------------- | -------------------------------------------- |
| 无个人记录时读取操作   | `work guide <action>`                        |
| 当前任务摘要与操作     | `work context <task> <action>`               |
| 自动初始化／建档／复用 | `work ensure --stdin`                        |
| 轻量变更读取／生成索引 | `work changes <prd> [key]` / `--write-index` |
| 结构化更新             | `work update <task> --stdin`                 |
| 列表／核对／同步       | `work status`、`work check`、`work sync`     |
| 资料分类／迁移核对     | `work documents`                             |
| 命令型实施             | `work exec <task> -- <argv ...>`             |
| 验证取证               | `work run`、`work evidence`                  |
| 最终交付               | `work deliver <task> --stdin`                |
| 交接                   | `work handoff`、`work receive`               |
| 原地保留历史           | `work archive`                               |

以下均由 Agent 在仓库根使用 `pnpm work` 调用，JSON 经 stdin 输入，输出供 Agent 继续判断。工具不读取私人 Skill 目录；操作只在调用时发生，不常驻调度。旧 `init <member>`／`start <task> <goal> [source.md...]` 保留兼容，普通新任务使用 ensure。下文 api-probe 表示工具返回的实际 task ID。

## 创建任务

先从[资料导航](index.md)选相关需求/契约，经[PRD 成果索引](tasks/index.md)核对相关结果。首次读回时按目标核对 `plan.result`：开发能力填 `{prd,key}`，确认无开发成果的维护／检查填 `null`，不确定则保留缺项先核对。缺项不能进入实施或取证；null 不是工具对目标的自动分类，也不代替语义审阅。未接受的误声明可用 update 纠正，旧原件和草稿保留为历史；已有接受绑定不能清除。维护验证后按需 archive，不造业务成果。

Agent 依 [拆解与生命周期](coordination.md#开始任务) 从公共 PRD／规格和当前用户目标形成执行任务，再调用 `pnpm work ensure --stdin`。下面是字段示例，不是预先决定的任务：

```json
{
  "requirement": {
    "source": "docs/api.md",
    "section": "Foundation API v1",
    "key": "api-probe"
  },
  "plan": {
    "goal": "完成已确认的 API 契约维护检查",
    "result": null,
    "scope": ["src", "tests"],
    "sources": ["docs/api.md"],
    "authorization": "填入当前用户实际给出的实施范围",
    "nonGoals": ["不提交、推送或部署"],
    "acceptance": [
      {
        "id": "checks",
        "criterion": "完整检查通过",
        "method": "automated",
        "command": ["pnpm", "check"]
      }
    ],
    "nextAction": "实施当前已授权的能力查询修改",
    "stopCondition": "验证后返回结果供人类审阅"
  }
}
```

返回 created、revision、task 摘要及 assessment。ensure／update／context 和 check 总是展示 result；旧记录缺项时也显示 null，但同时报告 `WORK_RESULT_REQUIRED`，不能仅看显示值推断已声明。旧记录仍可读，续接只补当前缺项，不迁移历史或改写旧接受。首次自动建立本工作区的 member.json；成员标签由真实工作区路径摘要生成，不是人员认证，复制到其他位置的目录仍拒绝。

requirement 由公共文档 source、实际章节 section 和 Agent 首次拆解选定的稳定 key 组成；key 用小写字母、数字、连字符或下划线，最多 80 字符。工具用 source＋key 生成 task ID，section 参与契约核对；新建须对应当前公共 Markdown 中唯一的真实标题文字，内联格式按 AST 读取，围栏里的假标题不算；标题可定位不证明需求语义正确，任务是否重复仍由实际审阅判断。不要因为换会话、改下一步或重试而更换 key；先 status 查询已有任务。续接可只传同一 requirement，返回原进度与证据，不创建替代目录或自动同步；不存在时须提供 plan.goal 才允许创建。已有任务中显式提交的 plan 字段不相同时报 WORK_CONFLICT，应查看原 context 后 update。

plan 的目标、范围、授权和验收来自真实任务。scope 是允许写入的文件／目录；inputs 默认 package.json 与 harness.config.json，再补实际依赖；sources 只登记实际遵循的需求子文档，requirement.source 自动参与摘要。实施前明确验收目标及 automated／review／behavior 方法；automated 完整检查的 `command` argv 按[记录证据](#记录证据)在正式取证前确定。其余字段按需填，不复制空模板。示例不授予权限，工具不认证授权文本的来源。

首次 ensure 保存初始检查点，完整且无阻塞的契约进入 C0_READY；不完整的记录保持草稿。ensure 退出成功表示已创建或读取记录，能否执行仍需核对 assessment 并展开必要引用。Agent 确认授权和依赖后用 update 标记实施，不会为每轮会话另建记录。原有 v1 任务和 `.work/evidence` 不迁移、不删除；新 clone 从仓库内生成器落地本人目录。

源码范围的 ensure／update 会补入 `quality-review`，保留已有同名 criterion 文本但要求 method 为 review。自动登记后的契约参与候选摘要；ensure 重试不重复添加，读取旧记录不会改写其契约。`assessment.qualityReview` 返回是否需要及当前原件状态；ready 只表示可继续执行，pending 审查仍阻止生成交付草稿。

## 核对与同步

`pnpm work documents` 无需个人记录，只读发现各 PRD 的 `documents.json`，有界列出 kind、identity、currentPath、aliases、registry、成果入口与校验问题；使用 `--select /documents` 或 `/results` 按需分页。登记格式与归属见[资料导航](index.md#增长与归属)。稳定 identity 可沿用原公共路径，不要求同名实体文件，实际正文由 path 定位；同名实体若存在，只能是 current path 或已声明且通过校验的 alias，不能遮蔽另一份普通规范。只有需要兼容旧 Markdown 链接时才保留并声明短导航 alias；移除前核对引用，已声明 alias 和当前正文仍必须存在。新请求的 requirement.source 和 result.prd 归一到 identity，来源读取解析到当前正文，稳定标识与当前路径因而找到同一任务与 book；旧 parse/load、accepted metadata 与历史 version.files 不归一、不重写。移除 alias、迁移或实际输入变化须审阅、sync 并重新核对受影响证据。普通文件输入和 Markdown 链接不因注册 identity 就允许悬空。未知活动任务页、重复身份/路径/别名、越界/私有/符号链接及不可发现资料拒绝；公开成果仍由报告孤儿检查保护。此命令不自动迁移文件或更新接受。

注册的活动资料按 PRD 稳定名称归属 `docs/tasks/<名称>/`，每个目录恰有一个 PRD；静态总入口通过真实任务目录展开登记导航，入口断链仍拒绝。prd 必须是同目录 prd.md，design/proposal 归属该 PRD，pending 仅存注册 proposal。成果位于同目录 complete，按登记 PRD 独立发现并校验 records/report 配对、内容哈希、身份、缺件与孤儿，不依赖总入口内的动态成果元数据。

```sh
pnpm work context api-probe resume
pnpm work check api-probe
pnpm work sync api-probe "已审阅实际差异，写明影响与下一步"
```

`status` 是任务目录，支持 `--query`、`--stage`、`--archived active|archived|all` 和分页；默认不展开归档任务，不执行全任务 assess，明确返回尚未核验。`context` 只核对选中的任务，默认提供有界字段、现场结论和当前动作的章节导航；`check` 仍完整核对契约、候选、原件和交付恢复。记录阶段、当前核验和真实接受分别表达，命令退出成功不等于通过或接受。

`guide <action>` 先返回章节入口，用 `--section <ref>` 展开本次必需正文。例如：

```sh
pnpm work status --query auth --limit 10
pnpm work guide start --section 'docs/coordination.md#开始任务'
```

记录字段、数组、核验错误与已登记证据默认有界，省略值给出明确的 `$read` 定位；沿返回 argv 调用 `read` 精确展开当前任务、核验细节或原件。分页使用 `--offset`、`--limit`，续页携带返回的 `--hash`，原件变化则拒绝混读不同版本。长字符串按 Unicode 字符分页，不直接截断 JSON；目录条数受限之外还有结构输出预算。请求或系统异常若无可重读来源，只给有界诊断并明确完整正文未持久化，不伪造详情入口。

`ready` 表示完整现场核验并计入审阅拒绝、规范问题等真实阻塞；`readyForAcceptance` 还要求当前证据与交付草稿就绪。二者不因输出省略而变为 false，也不代表已取得授权或人类接受。`checkedReady`／`checkedReadyForAcceptance` 保留底层核验值，不能绕过 blocking 单独使用。原 `blocking.unexpandedAuthority` 改由 `reading.omitted` 列出当前视图省略的关键字段名，精确入口仍在 task／requiredContext 的 `$read`；这不表示现场阻塞或此前没有读过。未核对的必要授权、范围、决策、阻塞及验收仍须展开；已核对且现场未变时复用，无需为清空省略提示重复读取。CLI 不保存已读状态，Agent 结合实际授权和当前核验判断下一步。

context、ensure 和成功 update 都返回完整现场核验的有界视图。已核对其中的实际结论、展开必要授权／阻塞／验收，且此后现场未变化时，可直接沿下一动作推进，无需再单独 check。退出码 0、stage、status 或仅 read 任务字段不具备这个含义；update 保存成功也可能返回待 sync 的现场差异。现场还包括原件、授权／依赖与在途操作，不能只看 revision 或 candidate 未变。发现变化或核验缺项时重新核对；命令入口仍执行实时前置与互斥，原生编辑仍遵守[实施与协作](coordination.md#实施与协作)。

命令前后记录的文件身份、大小及修改/变更时间依赖实际文件系统的元数据精度；内容摘要只比较观察时的字节。低时间精度文件系统可能无法观察同一时间粒度内等长修改后恢复原字节，记录不是任意瞬时物理写入的审计。执行期间仍须维持单写入者、停止修改受验输入并核对命令原件和候选；发现并发变化或无法满足所需证据时如实保留缺口。

`read-result <prd> [key]` 不需要作者 `.work`：无 key 时分页列成果，有 key 时默认读取 /summary，--select /result 读取完整简洁记录。只支持公共 v5；不存在 artifacts 或逐证据读取入口。输出仍有界，工具不能阻止宿主直接全文读文件。

`changes <prd>` 分页列该 PRD 的变更摘要，`changes <prd> <key>` 默认分页读取所选正文；两者支持相同 `--select`、`--offset`、`--limit`、`--hash`，续页内容变化时拒绝混读。`changes <prd> --write-index` 只生成所属 PRD 固定的 `changes/index.md`，内容相同不重写；无已登记变更时拒绝创建。该模式按[实施与协作](coordination.md#实施与协作)经 `work exec` 调用。缺失或过期索引由公共文档检查报告，但不阻塞生成器；正文格式、所有权及父章节错误必须先修复。读取不改变候选的完整文件绑定。

事实变化时，Agent 用 `pnpm work update api-probe --stdin` 提交，例如：

```json
{
  "revision": "使用最近一次 context、ensure 或 update 返回的 revision",
  "reason": "已核对当前授权与依赖，开始实施",
  "stage": "C1_IMPLEMENTATION",
  "plan": { "nextAction": "实施并运行相关检查" }
}
```

update 可改上述 plan 字段和非释放阶段（C1_IMPLEMENTATION／C1_EVIDENCE_PENDING），切换阶段或 reopen 须同时提供非空 plan.nextAction。已有定位可用 `plan.requirement={section:"实际标题"}` 更正，仅接受 section，保留 source/key/ID；更正进入候选，不重绑旧证据。id、member、workspace、checkpoint、evidence、人类接受或释放结论仍不可写。数组按字段整体替换，未提交字段保持原值。过期 revision、未知字段或非法值拒绝保存；冲突时先取新 context 核对，不能机械重试覆盖。请求设置 C1_IMPLEMENTATION 时须已有有效契约和现场核对；此处拒绝则整次更新未保存，sync 不会应用被拒绝的修改。若本次确需改契约，先不带 stage 保存，再审阅、sync 后用当前 revision 设置阶段；只有文件漂移时不补造契约更新。reason 记录实际变化或核对理由，不为每次读取写日志。

每次成功写入都可能改变 revision，不沿用 sync、exec、run 或 evidence 之前的旧 revision。WORK_CONFLICT 不覆盖 Task；工具在该任务的 `conflict.json` 保留一份未解决事实，context/check 报 WORK_RECONCILE，后续写操作在副作用前拒绝。按错误给出的精确路径读回执并对照当前 context；只有当前 revision、非空 reason 的合法 update 成功保存后，才将原冲突纳入现有 notes 并清回执。仅读取、sync 或新成功不清除它；若 update 改了契约，解消后仍需审阅和 sync，不要求先让旧候选通过。

未完成 delivery journal 优先沿原请求恢复，不叠加冲突回执；不得删 journal／回执绕过。回执写入失败保留命令占用，按命令恢复入口核对；更新已保存但清回执失败时保留事实，重读当前 revision 再对账。正常操作不增加审批或每命令 revision 参数；回执不复制计划、候选和证据，也不是“已读 context”的证明。

契约修改保留旧 checkpoint 与历史证据，并撤回旧接受／释放结论；Agent 审阅变化后再 sync，不能用 update 顺带承认未知代码变化。只改下一步且候选不变可沿用原证据。归档记录默认只读，确有当前授权时用 `reopen: true` 和非空 `plan.authorization` 显式重开，再核对及 sync。旧记录同样可用 update，不强制补 requirement。

check 只读；退出码按完整现场核验决定，缺失契约、依赖未就绪、归档、上下文或非法释放结论返回非零。有省略内容时还须按上述引用补全上下文；evidence 单独报告验收结果，ready 为 true 不表示任务已完成。

sync 更新检查点，保留历史证据；执行后刷新阶段后继，即使本次核对没有内容变化，也不能保留已经完成的同步动作，不代替业务规划。字节、任务契约、分支／HEAD 变化先审阅再同步；新候选撤回旧释放，旧证据不自动重绑。内容相同的提交／分支变化，经核对仍可复用同内容证据。

文件摘要覆盖固定公共策略、真正工程配置、任务实际声明的范围／输入，以及相关 PRD 登记和必要 alias；合法无关 PRD 的新增或正文变化不成为窄范围任务的隐式输入。同 PRD 未读取的设计／提案正文也不自动进入候选，登记变化仍会被检测；显式广 scope 按原范围展开。全量登记有效性校验继续执行。这是本机完整性读取，不是向模型注入正文；sources 不默认塞入全部操作手册。新公共包的精确输入可写为 `docs/tasks/<名称>/complete/records.json#result=<key>`，绑定该成果的简洁记录与所属登记；追加无关 key 不改变此内容候选。selector 严格解析为公共记录包与成果身份，实际文件仍受路径、符号链接和完整性校验；普通缺失输入照常拒绝。inputStamp 保留物理文件及祖先目录的改写检测，同一 checkout 的并发写入可能保守地使运行验收无效；隔离保证以独立 checkout/worktree 为边界。

## 实施命令

安装依赖、代码生成和其他命令型修改，在建档、当前现场核验通过并经 update 进入 `C1_IMPLEMENTATION` 后执行：

```sh
pnpm work exec api-probe -- pnpm add --save-exact package-name@version
```

工具仅按 argv 启动子进程，不经 Shell；检查任务归属、阶段、契约、候选漂移和未结束交付操作后才启动。未知任务、草稿、C0、取证阶段或现场变化均拒绝启动。命令退出码保留，失败产生的修改不回滚；不自动 sync、不制造验证原件。Agent 随后审阅实际差异再同步。此入口不是全局写入拦截器，编辑器操作仍须在写入前核对同一任务条件；调用成功不证明命令语义获授权或修改未越界。

需要 Shell 组合时，把完整操作作为子进程参数。例如下面是未执行的格式示例，实际目标必须在当前授权范围内：

```sh
pnpm work exec api-probe -- sh -c 'printf "%s\n" "document text" > docs/example.md'
```

不能写成 `pnpm work exec api-probe -- printf ... > docs/example.md`：外层 Shell 会在 CLI 检查前打开目标文件。脚本及 formatter 也直接放在 `--` 后；选择入口的统一规则见[实施与协作](coordination.md#实施与协作)。

### 命令占用与异常恢复

会写同一任务的 CLI 操作共用 `.work/tasks/<task>.command.json`，在读取可变记录前独占，直到命令结束和记录落盘后释放；ensure／receive 在得到目标 ID 后纳入。标记放在任务目录旁，首次建档在 state 创建前中断也不会仅因占用而留下伪任务目录。竞争者立即返回 `WORK_BUSY`，不启动子命令或登记原件；context、check、read、status 仍可读，不同任务不共用占用标记。标记记录本次 CLI PID、动作和已启动的子进程 PID，不是阶段、授权或第二份任务状态，不依赖超时或 PID 存活自动接管。

取消须有实际依据，例如已授权中断、超时／资源预算达到或核实异常；暂时无新输出本身不足，先核对已有日志和进程。`run`／`exec` 收到 SIGINT／SIGTERM 时转发给其启动的执行进程；Linux/macOS 使用执行进程组，等待直接子进程结束并核对同组进程。中断后即使子进程返回 0，也不得算成功；无法确认结束时返回非成功并保留标记。Windows 中断不能据直接子进程退出证明后代已停，同样保留标记。工具不管理脱离执行组的后台服务，命令应以前台方式结束；不能把 CLI 的取消当作撤销整个宿主任务。

硬终止或异常会留下标记。恢复者先读取它，核对原 CLI、执行组及相关进程确已停止，再用 context 和实际 diff／原件对账；首次建档尚无 state 时，从原目标按相同 requirement／ID 恢复，不能虚称已建档。确认没有在途写入后，可作为本工具的恢复操作仅移除该任务的 `<task>.command.json`，再沿原任务继续。已登记的未结算观察继续保持 pending，来源任务的回执也须重新核对。正常活动命令的标记不得手动移除，恢复不得修改 state、补造通过或删除原件。

## 记录证据

原件准备的阶段与写入方式统一见[验证与接受](coordination.md#验证与接受)；以下命令登记已有原件，不替代其准备步骤。自动证据 summary 只保存退出、取消、未结束和输入变化结论及必要异常诊断；完整 argv 保存在 artifact 指向的原件中，不复制到摘要。旧摘要仍可读取，不改写历史原件或重新绑定候选；实际复核命令与观察范围时读取原件。

```sh
pnpm work run api-probe checks
pnpm work evidence api-probe review pass .work/tasks/api-probe/evidence/review.md "实际审查范围、观察与限制"
```

run／evidence 先经 update 进入 C1_EVIDENCE_PENDING 并给出当前下一步；失败的阶段更新不能由取证补成成功。验收 ID 来自本任务 acceptance。C0／实施可暂缺 automated 的 `command`；取证阶段缺项会明确报错并阻止 run／evidence，包括显式传入 argv。可返回实施补齐检查脚本，阶段转换按目标阶段核验，现场漂移等检查仍有效。缺命令的自动验收保持 pending，不能 prepare／complete；已提供的非法命令始终拒绝。正式取证前确定完整命令及其实际读取的脚本／配置，覆盖原验收判据并纳入候选输入，审阅变化后 sync，不从命令名称推断覆盖。省略 argv 时 run 执行声明命令；旧记录不自动采信历史最后一条命令。

显式 `run <task> <criterion> -- <argv ...>` 可执行补测；argv 与声明相同才是完整检查，其余标为 supplemental，保留独立原件，无需新增验收项或切阶段。单次补测成功不能替代完整覆盖或清除其他失败；后续失败、未知、缺失、损坏或无效原件均阻断。排查后可重新完整检查，或按下节进行覆盖复核，形成基线与增量组合结论，旧失败保持不变。声明命令改变属于验收契约变化，不能把完整命令改窄来消除失败。

run 按 argv 启动不经 Shell，且必须在授权内。每次保存命令、完整输入 checkpoint、开始／结束时间、退出码、取消／未结束标记和环境快照；退出成功只表示该次命令成功。未确认结束或输入／环境指纹变化记 pending；取消且已结束记 fail。前后核对字节及文件／源目录身份和变更时间，不是沙箱或完整中间行为证明。原件登记前按[验证与接受](coordination.md#验证与接受)串行维护，补测不授予实施输入写入权。

启动子进程前先登记不可变的 `.start.json` pending 观察，保存候选、命令、输入与环境指纹和原始日志位置。结算按登记时的记录版本只替换本次账本项，正式原件绑定 start 路径及摘要；两份原件保留。硬终止或结算冲突留下本次未结算观察，先前的失败或未知继续保留。执行组未确认结束时，登记独立的 pending 观察和已知退出信息，活动日志保持原样。恢复时核对原日志与进程，后来的追加输出不足以确认通过。

### 增量验证与同输入复用

保留完整检查命令和公共 CI。使用 `work run <task> <criterion> --stdin` 可同时记录 `{"conditions":{"dependencies":"实际安装状态和核对依据","configuration":"实际配置和核对依据","external":"实际外部服务版本、测试条件或明确无外部依赖"},"command":["实际命令"]}`；省略 command 执行原声明命令。环境快照包含 Node／平台、依赖锁与 pnpm 安装元数据、根目录 `.env`／`.env.*` 文件摘要，以及 MIO_*、NODE_OPTIONS、NODE_ENV、TZ、LANG、CI 变量的整体摘要，不保存秘密值。其他配置、二进制、远端服务和数据条件由 Agent 在 conditions 中据实说明，相关文件纳入任务 inputs；指纹不是所有依赖字节或远端环境的自动证明。未记录 conditions 的旧用法仍能直接执行检查，但复用前须恢复其实际条件。

统一入口为 `work verify <task> <criterion> --stdin`。请求包含 action=inspect／record 及 baseline=`{task,criterion,sha256}`，仅引用同一 checkout 内显式指定的自动原件。inspect 不写记录，返回当前 revision／candidate、真实新增／修改／删除路径、命令、环境快照及未解决问题；源原件不可读或无效时返回明确错误。record 只在 C1_EVIDENCE_PENDING、当前现场已对账且 revision 匹配时登记，绝不执行检查。

record 另提供以下字段：

| 字段        | 含义                                                                                                                                                |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| mode        | reuse：输入文件映射、命令和适用环境相同；incremental：有效基线加本轮覆盖复核                                                                        |
| coverage    | 为什么基线与本轮观察覆盖目标验收项，包含入口、消费者、配置和恢复路径；不是空泛“通过”                                                                |
| environment | identity 为 inspect 返回的运行时，conditions 同上三类真实条件，reason 说明可比性及变化后的适用范围；工具自行保存当前指纹                            |
| impact      | 每个实际差异恰有一项 `{path,disposition,reason,runs}`；disposition 为 retain／retest，分别说明旧覆盖仍适用或需重验的理由；retest 引用非空本轮 runs  |
| runs        | 补测 `{task,criterion,sha256}` 列表，须为当前完整文件映射及环境下的通过观察；可引用真实执行或递归核验的范围回执，由 coverage 说明如何覆盖目标验收项 |
| resolves    | `{issue,reason,runs}` 列表；issue 是 inspect 列出的问题引用，说明故障定位、修复及关联回归；runs 仅接受发生在该问题之后的真实执行原件                |

例如一次局部修复，inspect 返回 `src/example.ts` 变化后，Agent 先执行该入口及其消费者／恢复路径的回归，再用 incremental、该路径的 retest 说明及真实补测引用登记。连续下一轮可引用上轮回执为 baseline；回执会递归核对原始执行，不能循环引用。新增／删除文件或配置变化同样必须解释。环境变化须有当前环境的真实补测和适用性说明，不能用 reuse 绕过。

真实补测通过后，下一候选只有无关变化时，可为该实际命令声明独立的 automated 验收项，以原执行为 baseline 复核差异，形成当前完整文件映射的范围回执，再作为总检查的 runs。保留原完整命令、任务 inputs、执行身份及原件，正文说明该命令的实际读取范围和变化适用性。范围回执只提供覆盖依据，resolves 拒绝把新回执的登记顺序当作新执行时间。来源后来失败、损坏或在途时继续撤回通过，verify 的 executions 为本轮实际启动次数 0。

reuse 与 incremental 均保留任务原候选身份。新 `.verification.json` 记录原始执行引用及复核事实，不伪装成重新执行；单独补测不产生组合通过。来源或目标后续相关失败不能被无关成功清除，来源链在途或遗留占用先按恢复协议处理。登记后改候选、损坏原件或新增问题，消费时撤回通过。交付、check 与交接使用同一判定；人工审阅与接受不自动继承。

用历史完整检查作为成功边界时，登记和重读回执均核对其文件映射与执行环境。不同输入或环境下的成功不能遮住当前输入或所保留基线上的既有失败和未知。恢复到曾失败的输入或环境后，使用适用的完整检查，或引用相关真实回归明确解决该观察。

无可靠基线、影响无法界定或原覆盖依据失效时执行全量，选择规则见[验证与接受](coordination.md#验证与接受)。旧记录不批量迁移：缺旧 checkpoint 时可提供 legacyCheckpoint，必须与日志原候选及快照摘要对应；缺环境记录时提供 legacyEnvironment=`{snapshot,reason}`，明确恢复三类条件的原件依据。已有指纹不得替换，无法核实的条件重新执行。日志和历史失败保持原字节，回执仅位于个人 `.work`，公共成果格式不变。

evidence 只用于 review／behavior，登记本任务 evidence 目录的真实原件或已取回的共享 Markdown。原件需写实际操作者、场景、输入／环境、动作、结果和限制。CLI 拒绝符号链接、硬链接别名和非普通文件，并按现存文件身份核对输入重叠及历史原件，不能通过大小写路径别名重登改写后的原件。共享原件同时属于候选输入时，先取回独立私有副本再绑定，避免原件声明进入自身候选。新观察另存，旧原件及失败保留；缺失的旧原件不阻止新路径补证。单任务占用标记只串行化 CLI，不认证宿主编辑者，原件归属沿[验证与接受](coordination.md#验证与接受)执行。

普通 review／behavior 原件附一个 `mio-evidence` 代码块，声明观察时的 candidate、acceptance 中的 criterion 和 result（pass／fail／pending）。例如以下未执行模板：

```mio-evidence
{"candidate":"实际受验候选的64位SHA256","criterion":"本任务验收ID","result":"pending"}
```

登记和后续 check／交付均核对声明与当前候选、验收项、命令结论及原件摘要；缺声明或旧候选不能在登记时自动套用当前候选。`quality-review` 和 `norms-review` 继续用下述专用块，不重复附通用块。旧原件可读且不批量改写，但无匹配声明不能作为当前候选的通过证据；这不改写历史接受事实。结构与哈希核对不认证独立性或观察真实。

`quality-review` 原件在普通 Markdown 中附一个 `mio-quality-review` 代码块。下面是未执行的模板，须由实际审查替换，不能原样填 pass：

````md
# 代码质量审查

记录实际基线／diff、调用链、问题位置、影响、已检查的反证与最小建议。

```mio-quality-review
{
  "candidate": "替换为 context 返回的当前候选摘要",
  "reviewer": "实际审查者及其是否参与实现",
  "scope": ["实际审查路径和相关调用关系"],
  "dimensions": {
    "algorithm": { "result": "pending", "evidence": "尚未核对输入规模、调用频率和资源成本" },
    "unused": { "result": "pending", "evidence": "尚未核对导出、注册、外部与测试消费者" },
    "reuse": { "result": "pending", "evidence": "尚未比较已有实现的行为与边界" }
  },
  "limitations": "尚未执行审查"
}
```
````

每维 result 为 pass／fail／pending／not_applicable，evidence 必须说明观察或不适用理由。三维中有 fail 则整体 fail，否则有 pending 则整体 pending，全部为 pass／not_applicable 才整体 pass；须与 evidence 命令参数相同。候选不匹配、缺维度、空依据和仅有“通过”文本拒绝登记。交付时再次核对原件；原件格式完整不证明语义正确，审查者仍须执行验证协议。

```sh
pnpm work evidence api-probe quality-review pending .work/tasks/api-probe/evidence/quality-review.md "实际审查进度与限制"
```

`norms-review` 复用同一 evidence 命令，判断方法只在[交回前三方对账](coordination.md#交回与下一步)维护。新原件附一个 v2 `mio-norms-review` 块，reason 与 plan.norms 一致；requirements 保存实际需求／方案来源观察，documents 对 norms.paths 逐页绑定当前摘要，accepted 保存人工核对的相关成果与关系，remaining 说明未完成项、剩余决定和下一步。下面是未执行模板，须替换为真实观察，不能原样填 pass：

```json
{
  "version": 2,
  "candidate": "context 返回的当前候选",
  "reviewer": "实际审阅者",
  "reason": "与 plan.norms.reason 完全相同",
  "requirements": {
    "result": "pending",
    "assessment": "尚未对照要求和方案采用状态；无独立设计时说明真实理由",
    "documents": [
      {
        "path": "实际声明的需求或方案当前路径.md",
        "sha256": "当前候选中该页的摘要",
        "assessment": "尚未核对已完成、未完成及未采用范围"
      }
    ]
  },
  "documents": [
    {
      "path": "docs/实际规范.md",
      "sha256": "当前候选中该页的摘要",
      "result": "pending",
      "assessment": "实际覆盖、修改与未决核对"
    }
  ],
  "accepted": {
    "result": "pending",
    "assessment": "尚未核对旧接受与本轮新能力或同 key 更新的关系；无相关成果时写真实理由",
    "results": [
      {
        "prd": "实际公共PRD稳定身份.md",
        "key": "actual-result-key",
        "candidate": "该成果当时受验的候选摘要",
        "assessment": "尚未核对接受范围与本轮关系"
      }
    ]
  },
  "remaining": "尚未核对未完成项、剩余决定和下一步",
  "conclusion": { "result": "pending", "evidence": "尚未逐页核对当前候选" },
  "limitations": "尚未执行"
}
```

requirements.documents 必须覆盖 requirement.source、result.prd 及 sources 中已注册的 prd/design/proposal/change 实际页，去重后用 currentPath，而非迁移 alias；不能靠原件添加未声明来源。没有任务资料注册的旧仓库／fixture，sources 中除 norms.paths、已知导航和成果存档外的声明页也按来源核对。维护规范章节可同时作为需求来源，其余普通规范和纯导航不重复填写。requirements.assessment 要说明要求及方案关系；无独立设计不需造文件。无规范影响时 documents 为 []，仍核对 reason；无相关接受时 accepted.results 为 []，assessment 写真实理由，不虚构成果。

需求、各规范页和 accepted 的 result 只能是 pass/fail/pending，总体按 fail 优先、其次 pending、全部通过才 pass 推导，并须与 conclusion 及 evidence 命令参数相同。缺三方项、缺来源／规范页、不匹配候选、声明或页面摘要、空观察均拒绝。accepted 中 PRD/key/候选仅检查结构，不认证成果存在或接受真实；实际依赖另用 inputs 绑定，不能把原件当作实时镜像。旧声明和原件读取兼容；旧 norms 声明用于新登记前，须显式 update 到 v2、核对变化并 sync，旧通过不转移；已为 v2 的声明无需重复升级。

当前候选每项按上述方法核对有效原件；缺失或损坏会影响完成判定。旧释放缺证时先经 update 回到 C1_EVIDENCE_PENDING 并撤回当前接受，再显式补证，授权、依赖与上下文检查仍有效。明确开发成果收到针对候选的真实人类接受后，通过下述 deliver complete 设置接受与释放；维护任务交回适用验证后按需 archive，不生成公共完成包。自动通过不代替真实接受。

## 交付命令

开发成果先用 ensure/update 明确 `plan.result={prd,key}` 和 `plan.norms={version:2,paths,reason}`；prd 必须是注册 PRD 的稳定身份，key 保持稳定。必要规范与实现一并进入候选，当前 norms-review 及其他必需原件必须通过。维护声明 `result:null` 及适用 norms，不执行公共交付。

v2 私有交付契约与公共 v5 格式含义不同。旧个人状态继续可查看；旧交付草稿和 v1 journal 不再发布或重放。显式新 prepare 校验当前契约后可替换旧 journal，新 journal 未结束时仍阻止其他记录写入。个人文件不批量迁移。

输出排除仅限本 PRD 报告导航和当前成果键。静态总入口及其他成果、代码与规范仍按真实声明范围参与候选，不忽略整个 complete 目录。

全部验收项通过后，由 Agent 准备草稿：

```json
{
  "action": "prepare",
  "revision": "当前 revision",
  "title": "实际完成能力",
  "locations": [{ "path": "src/http.ts", "purpose": "实际入口及职责" }],
  "outcomes": "实际完成能力和范围",
  "verification": "实际验证方法、环境与结论的简短摘要",
  "limitations": "未覆盖范围及重要限制"
}
```

prepare 沿[记录证据](#记录证据)核验每个验收 ID 的当前有效原件。locations 必须指向真实公共源码或文档文件。只生成个人 delivery/draft.md，保存可读成果与原件元数据绑定，不复制公开附件。返回 revision、draft.sha256 和 readyForAcceptance，记录 HOLD_FOR_HUMAN_REVIEW；摘要真实性由实际审阅保证，草稿存在不表示接受。

本地用户可审阅草稿；跨人评审沿既有共享渠道取得实际需要的代码和原件，不默认生成永久公共 pending 报告或自动上传。

取得针对该结果与候选的真实接受后：

```json
{
  "action": "complete",
  "revision": "准备后当前 revision",
  "draftSha256": "已审草稿摘要",
  "acceptance": {
    "candidate": "已接受的受验候选",
    "statement": "真实接受意见",
    "reference": "可核对的接受来源或对话定位"
  }
}
```

complete 再核对必需原件、候选、草稿和接受绑定，从注册 PRD 当前路径确定同目录 complete。v5 records.json 保存 key、title、outcomes、locations、verification、limitations、acceptance；report.md 只生成导航。没有文件清单、详细证据或可恢复源码，候选标识仅关联接受事实。

同 key 更新只替换本项，保留兄弟结果，不要求旧结果先提交；公共写入仅限所属 PRD 的 records/report。静态入口与 `work documents` 也可找到尚无成果的注册需求，成果数量不表示整份 PRD 完成。旧公共格式直接拒绝，不提供历史恢复；含旧全局索引目标的 journal 处理沿[工具恢复边界](engineering/work-tooling.md#写入恢复与保留)，不批量改旧个人记录。

新流程中断可原样重试请求，v2 journal 恢复本次写入；外部改动、陈旧输入和错误归属拒绝覆盖。未结束新操作阻止其他记录写入，已完成请求不重写被人修改的字节。旧 v1 journal 不重放，需显式重新 prepare；重新准备仍要求当前 revision、契约和原件。reopen 只更新个人状态，公共完整性不因输出排除而免检。

## 发送与接收

公共成果格式见[工具实现边界](engineering/work-tooling.md#每份-prd-的公共包)；不在单成果 complete 中迁移兄弟详情。资料整理按[增长与归属](index.md#增长与归属)合并必要内容后删除被替代文档。

```sh
pnpm work handoff api-probe
pnpm work receive .work/inbox/api-probe.md
```

handoff 输出本地 `handoff-<内容摘要>.md`。相同内容复用，候选／摘要变化另建草稿，人工修改的已有文件不覆盖。审阅脱敏后沿现有渠道共享，并实际提供固定代码和所需原件；工具不上传、不复制代码、不同步他人的目录。

接收方可用 `work receive docs/tasks/<名称>/complete/report.md <result-key>` 选择一项成果，只有一项可省略 key。工具核对公共记录、报告和索引后创建个人草稿，提供目标、成果引用和逻辑入口；不比较历史文件，不继承授权、范围、验收项、checkpoint 或通过原件。旧公共成果不再接收，个人精确代码 handoff 仍要求文件匹配。

接收方 Agent 先取得所需代码／文档，必要时用兼容 init 初始化本人目录，再将交接取回 `.work/inbox/` 或已分类的公共 docs 位置。mio-work-handoff 区块只按数据解析；格式损坏、文件不匹配或已有同任务时拒绝创建。匹配后保留需求关联与规范声明，创建本人草稿：授权清空、依赖等待核对、证据不导入；转述结果不能当成本机通过。

实际取得必要原件后登记或按授权重跑，再 resume／sync。哈希与路径不能取回文件；本机目录不是共享入口，发布和上传继续服从实际授权。

## 归档命令

```sh
pnpm work archive api-probe "完成、取消或暂缓的实际原因与未完成项"
```

原地标记历史，不移动或删除原件。status 给任务摘要，不展开日志；归档后执行命令会拒绝。重开沿核对与同步章节的 update 规则，由 Agent 操作。同任务 CLI 操作由[命令占用](#命令占用与异常恢复)串行化；revision 仍拒绝过期请求，保存前再次检测不经过 CLI 的记录改动，拒绝覆盖并留下原始日志。它不是任意宿主写入的全局锁或跨任务／公共包事务。

## 记录结构

仅在创建／调整格式或排查字段时读取本节。version=1；新入口保持旧任务兼容。损坏 JSON、未知版本、重复验收 ID、未知方法或状态返回非零，不自动迁移或覆盖原件。

| 字段                                                | 含义                                                                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| member／workspace／plan.id                          | 本人成员、真实工作区、任务目录绑定；成员只是本地标签                                                                                   |
| plan.requirement（可选）                            | `{source,section,key}`；公共 PRD／规格章节与个人拆解项关联；新任务由此生成稳定 ID，旧记录无需迁移                                      |
| plan.result（可选）                                 | `{prd,key}`；明确开发能力的公共 PRD 与稳定成果键；缺省为未声明公共成果，仅维护个人记录、不自动发布                                     |
| plan.norms（开发成果交付必需；维护可单独启用）      | `{version:2,paths,reason}`；实际现行规范和理由，空 paths 表示明确无影响；norms-review 绑定三方观察、候选及实际页面摘要；旧版本只读兼容 |
| plan.goal／scope／inputs／sources                   | 目标、写入范围、所读代码／配置、相关需求文件                                                                                           |
| plan.authorization／nonGoals                        | 真实授权与非目标                                                                                                                       |
| plan.acceptance                                     | ID、可观察判据、automated／review／behavior                                                                                            |
| plan.decisions                                      | `{status,text,source}`；CONFIRMED／AI_PROPOSED／OPEN／REJECTED，OPEN 仅列影响当前动作的取舍                                            |
| plan.dependencies                                   | `{task,ref,ready}`；ref 为团队可访问的来源，ready 由执行者实际核对                                                                     |
| plan.blockers／nextAction／stopCondition／sharedRef | 当前阻塞、下一步、停止条件、同一共享权威来源                                                                                           |
| stage／reviewDecision／releaseDisposition           | 当前切片状态、人类 PENDING／ACCEPT／REQUEST_CHANGES／HOLD、HOLD_FOR_EVIDENCE／HOLD_FOR_HUMAN_REVIEW／RELEASED                          |
| checkpoint                                          | HEAD、分支、所选文件哈希、契约哈希、候选标识                                                                                           |
| evidence                                            | 验收 ID、方法、pass／fail／pending、候选、原件路径／哈希、摘要和环境；历史追加                                                         |
| notes／archived                                     | 对账说明与历史标记，不自动删除                                                                                                         |

固定策略文件 AGENTS.md、协调协议和本页仍完整参与摘要核对；不是默认阅读全文的清单。scope／inputs 的目录展开已分类文件，包含未提交与未跟踪内容；scope 可以有尚未创建的目标，sources／inputs 缺失则报错。绝对路径、..、符号链接、私有／凭证／生成目录不可作为公共输入。

候选绑定所选字节和契约；成员、绝对工作区、HEAD 不进入内容候选，单纯提交相同内容不使证据失效。下一步、阻塞、共享导航、阶段标签不改变候选；需求关联、result 归属、目标、范围、来源、授权、验收和决策改变会改变候选。未显式升级的旧记录保持原候选算法。revision 是整份当前记录字节摘要，和候选用途不同：进度或 notes 更新也会改变 revision。

可选 delivery 保存格式版本、私有草稿和最后接受引用。v2 accepted 的 path 指向 PRD 汇总，key 指向成果，sha256 是该成果规范 JSON 摘要，candidate 是其受验候选；兄弟成果变化不改这个绑定。公开 report 中的 sha256 核对所属 records 文件内容，两者用途不同。它不是通用输出排除开关。

公共协议、源码、测试、PRD 已接受成果摘要入库；护栏维护与演练不计 PRD 进度。member.json、tasks/<task>/state.json、原件、待接受草稿、handoff 和 inbox 位于忽略的 `.work`。公共 CI 不读取成员内容，也不替代本地 work check；公开摘要不能冒充完整私人原日志。备份和传输沿真实项目选择，缺少原件时不能推断已恢复。
