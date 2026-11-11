# 源码与依赖护栏

[底座规则总览](../foundation.md#已采用规则与验证)。本页维护检查器的覆盖口径、依赖约束与维护验证；普通文档任务无需展开。

开发模块的 `developmentDependencies` 按源码根声明：护栏／任务协调只导入 `scripts/harness/` 内部模块；服务工具允许自身模块及认证、对话、供应商、资产和计算迁移需要的精确配置与 schema，以及共享计算合同的构建公开类型入口。动态目录的受控部署导入另精确允许 `src/providers/store.ts`、`contracts.ts`，由存储入口统一完成归属、版本和声明校验，导入程序自持并关闭该域池；不开放整个业务目录、`catalog.ts` 或 `service.ts`。总检查入口可组合各自命令。开发角色不等于职责边界，类型、重导出和别名解析后的越界均受核对；静态规则不是任意子进程或网络副作用沙箱。

认证包的生产导入限定于 `src/auth/`；PG 驱动另允许精确的 `src/conversations/store.ts`、`src/conversations/schema.ts`、`src/providers/store.ts`、`src/providers/schema.ts`、`src/assets/store.ts`、`src/assets/schema.ts`、`src/compute/store.ts` 与 `src/compute/schema.ts`，不放开整个业务目录。认证包和数据库包分别按导入名称、解析包身份及真实归属判定，PG 身份不能豁免同时识别出的认证身份。服务迁移与部署声明入口的精确导入集合见 developmentDependencies；不授予认证内部池或护栏模块权限。合法 PG/部署别名及临近非法目录、type-only、跨职责反例进入 `tests/guardrails.test.ts`。

根服务 A 中 COS SDK 包仅允许 `src/integrations/cos.ts` 导入，开发工具和其他 A 模块不得直接或经别名导入；B 的精确适配器按下述多项目声明约束。检查按导入名称、解析包身份和真实归属识别。类型、别名及邻近非法文件反例见同一 fixture；运行权限仍由 COS 凭据、桶策略与实际测试保证。

Redis 驱动包的生产导入只允许 `src/integrations/redis.ts`；开发工具也不能直接或通过本职责内 helper 导入 Redis 驱动。公共 Redis 不反向依赖消费者、插件、脚本或测试，只允许独立公共契约作为本地依赖；插件和认证可消费公共资源，迁移工具仍由已有 developmentDependencies 禁止导入该运行模块。AST 与包归属解析覆盖类型导入、重导出和别名；真实 Redis 测试夹具允许导入驱动。新增文件继承 `src` / `tests` 既有分类、类型检查与构建范围，不为目录形状新增冗余配置。这是静态导入边界，不能拦截任意宿主子进程或网络副作用。正反例见同一 guardrail fixture。

共同响应模块 `src/http-response.ts` 的依赖限定为 `node:http`、`node:crypto` 与解析后指向 `src/contracts.ts` 的本地模块；认证、插件入口、其他包和开发脚本均不可作为其依赖。现有 AST 导入/导出采集与模块解析同时检查 type-only、重导出、类型查询与别名路径，报告 `HTTP_RESPONSE_DEPENDENCY`；合法直接导入和契约别名、违规认证类型/重导出/别名等在同一 guardrail fixture 验证。此规则检查模块方向，不是对 Node 包内符号的数据流沙箱；实际实现只导入 HTTP/ApiError 类型与 UUID 函数，公开符号及真实消费者继续由 quality-review 核对，不据此宣称全部 `src` 内部方向均已隔离。

已登记的 TS 文件还必须进入类型检查配置；生产 TS 必须同时进入构建配置。新增根目录仅登记归属不足以通过，检查器会对账编译器实际匹配的文件集合。

私有 `.env` / `.env.*` 不进入源码清单或任务候选。唯一例外是仓库根的公开 `.env.example`：须在 `configurationFiles` 登记，参与候选摘要，且不能是符号链接；模板只放占位值，真实秘密留在忽略的私有文件。

多项目使用 `harness.config.json` 的 `projects` 具名对象：每项声明 `kind`（`service` 或 `contract`）、`packageRoot`、`sources`、`typecheck` 和 `build`。根服务的 `packageRoot` 为 `.`，且现有 `src` 只能归属根服务；其他生产根须在 `sourceRoots` 中登记并唯一分配给一个项目。项目的配置路径各自独立，源码根不得重叠，也不得与生成或私有排除路径重叠；未知 role、重复 JSON 键、越界路径及未声明的生成目录显式失败。未配置 `projects` 时仅支持现有 `src` 单生产根，不因出现第二个目录自动推断项目。

每项 `typecheck` 和 `build` 指向本项目真实 TypeScript 配置；对应生产文件须进入各自配置的文件集合，其他项目生产文件不得作为其显式编译根文件，本项目测试仍可进入类型检查。构建还须能生成运行代码、使用已登记的生成目录。生产导入按类型和构建两套配置解析，避免两者别名指向不同内部模块。此处核对配置与输入，不执行编译或证明产物存在；根入口仍须实际执行每个项目的类型检查和构建，并单独验证产物。

根类型检查先构建共享合同，再检查 A 与 B；根构建依次构建合同、A 与 B。A 的 `dist/tools` 额外编译既有 auth、assets、compute 三个迁移入口及 profile 准备入口，使仓库外产物可初始化和装载；这些工具仍遵守其源码的 developmentDependencies，A 生产模块不反向导入工具。只编译本期实际需要的入口，其他业务域仍使用原有迁移方式；产物和数据库变化需实际验证。

服务只能依赖自身源码或 contract 的已声明公开入口，contract 只能依赖自身项目，不能导入其他服务或 contract。普通外部校验包仍可使用，但静态包边界不证明依赖纯净或没有副作用。contract 用 `publicEntries: [{"source":"contracts/compute/src/index.ts","export":"."}]` 将受审源码入口关联其 `packageRoot/package.json` 的 `exports`；运行条件须选择该入口编译得到的 `.js`，类型条件须选择对应 `.d.ts`。当前只支持按声明顺序选择 `types`、`node`、`import`、`default` 条件，不支持条件数组或其他条件；构建后应实际加载包验证。解析目标即使被 TypeScript 标记为外部包，也按真实路径及包身份识别本仓库项目；生成的 `.d.ts` 不代替源文件覆盖。

非根服务可通过 `capabilities` 对 `fs`、`child_process`、`sqlite` 分别登记本项目内真实存在的精确 TS adapter 文件；`node:` 前缀及 `fs/promises` 按对应能力核对，根服务仍不开放这些能力。直接的 `process.getBuiltinModule(...)` 和 `globalThis.process` 的静态属性/字符串下标形式也受检查：目标须为字面量，脱离调用的引用拒绝。计算属性、任意别名、第三方内部行为和运行时反射不在承诺内，静态规则不是进程沙箱。

`packageAdapters` 可按服务的真实 adapter 文件精确登记 `amqplib`，并允许非根服务登记 `cos-nodejs-sdk-v5`；未知包键、跨项目和不存在的文件拒绝。A 的 COS SDK 仍只允许 `src/integrations/cos.ts`，声明不覆盖 DSH、认证、PG 或 Redis 等既有边界。包名、类型包身份及解析目标的包归属共同参与核对。P2 增加这项声明是因为 B 使用独立凭据访问 COS、A/B 都可能需要各自的 MQ adapter；逐服务在检查器源码中硬编码路径会把正常新增服务变成护栏实现修改。代价是维护显式声明与正反例，不能据此推断运行时隔离。

常驻环境的 MQ 初始化工具通过 `developmentDependencies` 精确声明复用 `src/integrations/rabbitmq.ts` 的连接/关闭能力，验证 A/B 登录；不发布或消费业务消息。服务工具仍不能直接导入 amqplib，生产代码不依赖部署工具，拓扑声明留在 `scripts/service/`。

精确的 `@earendil-works/pi-ai`（含 `/models`、`/api/*` 公开子路径）属于同一 DSH 适配边界，按导入名、解析 packageId 与真实包归属识别，不放宽其他 npm 包。conversations/providers 不能反向导入本地 src/dsh。合法适配、临近非法目录、普通业务、type-only 别名及本地越界在同一 guardrail fixture 验证。

体量统计来自 TypeScript AST：物理行数（含注释/空行）、函数声明跨度、语法块嵌套深度、if/循环/case/catch/条件表达式节点数。`decisionNodes` 是文件级分支信号，不是完整圈复杂度或算法复杂度；职责聚合、时间/空间成本由相关变更审阅。配置/文档/生成文件不计入业务源码指标。依赖声明采用 `skipLibCheck`，严格类型检查覆盖本项目；第三方声明内部仍由依赖兼容与装载测试补充。

AST 入口为 `scripts/harness/check-source.ts`：通过 TypeScript Compiler API 提取静态导入、导出、`import type`、字面量动态导入/require，并调用模块解析器建立项目内依赖边。框架入口限制、运行时不得依赖开发脚本、未解析的相对导入、已识别的循环、未进入类型检查/构建的源码返回非零；未知/未分类文件由盘点入口阻断。不支持的源码类型显式报告，不降级成文本猜测。该检查不提供完整的数据流分析、任意运行时反射目标追踪或进程安全沙箱；`pnpm typecheck` 和 `pnpm lint` 仍独立执行。

DSH 边界同时核对导入名称、解析器的 `packageId` 和解析目标真实路径向上最近具名 `package.json` 的包名，任一身份指向框架包即受限制。没有 `name` 或 `name` 为空字符串的子目录元数据继续向上查询；遇到最近非空包名即确定归属，遇到 `node_modules` 目录或文件系统根则终止查询，避免把匿名嵌套依赖归到外层包。框架身份由包元数据认定，`node_modules` 只作为查询边界，不按安装目录名称或 pnpm 布局猜测身份。`paths` 别名可能缺少解析器包身份，文件级符号链接也可能保留外层包身份，因此真实目标始终参与判定。已有包元数据读取／解析异常返回失败。生产代码中只有 `src/plugin.ts` 和有界 `src/dsh/` 适配目录可访问框架包；临近 `src/dsh-other/` 不取得权限，不整体放开 `src/`。新文件继承既有生产分类、类型检查与构建范围，合法与违规的类型/别名导入沿同一 fixture 验证。普通本地别名与其他包保持可用；已有 import／require 条件解析和开发模块隔离继续生效。实际运行和持久化责任见 [DSH 集成契约](../integrations/dsh.md)。

最小维护验证：使用已有 guardrail fixtures 验证合法同模块新文件、类型导入越过框架边界、运行时依赖脚本、循环、新增根目录漏编译，以及长而低分支函数仅报告。改变 AST 支持或边界判定时再补对应样例，不以文档包含“AST”或规则 ID 代替行为验证。语言、代码形态与职责由各自适合的检查负责，不把分支数当作算法优劣。

工具链采用 TS 编译器解析源码、ESLint 和 Prettier，以及 Vitest 执行行为测试。文档用 CommonMark 解析器核对本地链接；不复制个人 Python 模板，从而保持项目开发检查只需 Node 工具链。DSH CLI 的传递依赖较多，安装依赖不意味着 Profile 已装载这些能力。锁定 `@opentelemetry/api` 为 `1.9.0` 以匹配本次 DSH 所带 OTel SDK 的 peer 范围；升级时复核该 override。
