# 本机计算 Worker

仓库内开发、人工测试优先使用[常驻环境](../docs/local-environments.md)的 `compute:init:dev/test` 与 `compute:start:dev/test`；初始化只做一次，启动在前台运行，使用该环境独立的 broker 身份和 journal。`start:dev/test` 启动主服务 A，不会同时启动 B。MQ 权限与部署边界见 [RabbitMQ 契约](../docs/integrations/rabbitmq.md)；下列原始入口仍用于独立部署产物。

本进程使用受限 B 身份消费视频转码、`audio.inspect.v1` 及通用媒体命令并发送结果。需要 Node 24、`ffmpeg` 和 `ffprobe`。通用媒体启动检查 x264、AAC、VP9、Opus、MP3、PCM、JPEG、PNG、GIF 编码及实际使用的滤镜。缺少能力时通用媒体返回 `CAPABILITY_UNAVAILABLE`。先用仓库根 `pnpm build` 构建共享基础库、协议和 Worker，独立产物须提供这两个工作区运行时依赖，并准备由运行身份拥有、其他用户不可访问的独占持久目录。环境提供 `MIO_COMPUTE_DIRECTORY`、持久不变的 `MIO_COMPUTE_INSTANCE_ID`、B 专用 `RABBITMQ_URL` 和 `MIO_COMPUTE_BROKER_USER`、A 专用发送身份 `MIO_COMPUTE_EXPECTED_COMMAND_USER`，以及 `MIO_COS_BUCKET`、`MIO_COS_REGION`、`MIO_COS_SECRET_ID`、`MIO_COS_SECRET_KEY`；临时凭据还需 `MIO_COS_SESSION_TOKEN`。不要把凭据写入日志或仓库。非回环 RabbitMQ 连接须使用 TLS。

首次新建卷时显式运行 `node compute/dist/main.js init`，其后运行 `node compute/dist/main.js start`。已有卷丢失、损坏或实例身份不一致时，停止消费并调查；不要对已有卷重新初始化。journal、WAL、SHM 和未确认的输入/输出都须保留在一起。目录是单实例独占的；SQLite 的锁在进程退出后释放，各事件和状态独立提交。

已有 journal 在核对实例身份及完整性后逐次升级。SQLite schema 7 增设媒体 attempt、事件与控制记录。schema 8 增设 Worker 启动序号、持久控制决定及遥测 outbox，保留既有转码和图片历史。升级前先备份卷，并显式执行 A 的 `compute:migrate --apply` 增量迁移。升级中断后沿同一卷恢复。应用回退前须先暂停新准入并核对在途任务和未知副作用。终态结果已持久化且发布确认、未被退回后，本地文件可幂等清理；重投仍从 journal 应答，不重新计算。journal 的 `ack_dispatched` 只表示本地 ACK 调用返回，AMQP 没有该 ACK 的服务端回执；`cleaned` 记录本地文件清理，二者不能证明 broker 已收到 ACK。未知状态继续保留文件。

未启用观测的 B 视频转码命令通道使用 `prefetch=1`。在启用观测的 B，转码、音频检测与通用媒体计算通道均以 `prefetch=32` 有界接收，实际并发由共享槽决定。各控制通道独立使用 `prefetch=1`。云端图片生成、查询及物化恢复已迁至 A 的独立生成服务，不需要向 B 注入 OneLink 凭据或图片 RSA 私钥，也不消费图片专用队列。旧图片消息不能交给新 B 重跑；切换前应按[图片迁移要求](../docs/tasks/onelink-image-generation/changes/image-generation-in-a/change.md)排空并对账旧任务、outbox、消息、journal 和部分产物。

音频检测始终使用独立命令连接，可与视频并行。未启用观测时其命令通道为 `prefetch=1`。B 共享一个计数槽池，视频消耗 encode，音频检测消耗 probe，默认与最低部署硬上限为 total=2、encode=1、probe=1。槽一直保留到本次收尾，视频进程未确认退出时 encode 保持 HOLD。启用前按 [RabbitMQ 契约](../docs/integrations/rabbitmq.md#拓扑与权限)预置音频队列和结果 stream。B 仅从配置的私有 COS 桶读取消息指定的样本原件或该任务成品检查点，核对对象键、ETag、字节数及已有摘要。检测完整的单音轨，返回格式、MIME、编码、采样率、声道、字节数、SHA-256 和解码实测时长。样本允许 MP3/WAV/M4A、至多 20 MiB、10–300 秒。成品允许 MP3/WAV/FLAC、至多 100 MiB、1 毫秒至 60 分钟。超出时长范围或解码失败返回失败结果。

临时输入位于实例目录的 `audio-inspection/`。B 拿到 journal 独占锁后清理其中残留的请求输入。音频检测仅读对象，可在重投时再做一次，发布结果后才确认消息。视频 journal 的状态和恢复流程继续沿用。

既有 journal 的图片历史表和卷保留供只读对账；运行时不再写入或接管这些图片记录。视频的恢复、独占目录和实例身份规则继续生效。

进程启动意图已提交而 PID 尚未持久化时，Worker 会发送 `PROCESS_UNKNOWN` 并暂停新的 encode 任务。重启不能证明旧进程结束。人工应先停止 Worker，核对同一宿主、启动周期和进程命名空间，并通过覆盖该运行环境的进程/隔离运行时记录，确认对应 FFmpeg 及其子进程均已终止。无法确认就保持 HOLD。**只有人工实际完成确认后**，以同一目录及实例身份运行 `node compute/dist/main.js resolve-no-pid <attempt-id> --confirmed-process-terminated '<确认依据>'`；它只接受无 PID 的 unknown 记录，保存依据并持久创建 interrupted 事件。再次启动后有界对账会发布该事件。该操作不会重新执行原 attempt。

视频上传结果未知时保留原输出和 journal，继续按固定 attempt 键对账。连接或读写无进度的 60 秒超时与总预算不同；本地超时不证明远端 PUT 已取消。视频未知上传恢复通过 GET 流式校验完整内容，未知对象内容不符或本地输出缺失时保持待对账，不删除 COS 资产。

图片产物与恢复目录归属 A，见[图片接口与恢复约定](../docs/apis/compute.md)。

## 通用媒体执行与恢复

[通用媒体 HTTP](../docs/apis/compute.md#通用媒体处理)的基础操作、视频派生和渲染使用独立的 encode、probe、control 通道，共用单路转码和独立音频检测的 total/encode/probe 槽。单次 attempt 实际执行预算为 60 分钟。FFmpeg 解码、编码与滤镜线程配置为 2。进度按事件流合并，诊断只保存有界尾部。波形按原采样率在 FFmpeg 内产生不超过 1024 个样本一帧的能量统计，B 流式合并到最多 4096 个桶，保留原采样率的高频能量与各声道能量。跨桶帧按重叠样本数分摊，桶边界是近似值。以 192 kHz、单小时为例，最多产生 675000 个统计帧，按每帧 256 字节的解析预算约 173 MB。常驻聚合状态最多为 4096 个数值和一条未完成记录，最终回执最多 4096 点。

运行实例使用 10 GiB 工作目录预算并保留至少 2 GiB 空闲。收到输入时在文件打开前、写入期间每 8 MiB 及结束后检查，FFmpeg 运行中以一秒为间隔轮询并在收尾时核对。文件和存储流按 1 GiB 限制核验。部署也须用容器或宿主机的 CPU、内存和磁盘配额限制最坏瞬时用量，轮询有检查间隔。

视频派生检查 FFmpeg 的 HLS/MPEG-TS muxer 及音轨补齐滤镜。普通 HLS 打包步骤在检查点中绑定规范化子清单及列出的全部分片，合法亚秒分片保留原 EXTINF 时长，目标时长至少 1 秒。两档 HLS 使用无 B 帧的编码以保持低帧率音画在独立分片处的时间基准。启用自动派生前按[常驻环境](../docs/local-environments.md)确认已替换并停止旧 B。画布模式最多 720 秒，独立编码并保存每个至多 4 MiB 的分片检查点。每片在 MPEG-TS 初包标记计数器复位。有音轨时先连续编码一次 48 kHz AAC，按帧时钟写入有界的本地分段并保存同一检查点。各档视频分片复用对应的完整 AAC 包，在视频切点附近保留源音采样。备用 FFmpeg 构建须支持 segment muxer、`aresample` 和用于去除首个预启动包的 `noise` 位流过滤器。已完成步骤在续跑时按摘要复用，损坏或缺失时保留原 attempt 供对账。

渲染需要可用的 x264、VP9、AAC、MP3 编码器、`ass`（libass）、`overlay`、`tpad`、`loudnorm` 等滤镜及 concat demuxer。启动能力检查还用 `fontkit` 打开两个 Noto CJK OTF，验证中文字符与布局度量。生产包的 `fonts/` 包含 Noto Sans CJK SC、Noto Serif CJK SC 及 OFL 许可，ASS 渲染从同一 B 包的该目录加载字形。使用 [B 独立产物流程](../docs/tasks/compute-service/design.md#本机独立产物与启动)打包部署，完整复制 `dist/`、`fonts/` 及生产依赖。可在仓库外用 `node tests/packaging/portable-media-probe.ts <绝对产物根目录>` 验证 `b/` 包及四种编码。先升级全部通用媒体消费者 B 并通过能力检查，再升级启用新渲染操作的 A。

视频混剪与合成的拼接清单由 B 以已完成的本地 MP4 片段生成。各片段关闭 B 帧，按全局累计帧数确定拼接切点，保持解码与呈现时钟连续。字幕使用受控 ASS 文件。素材输入继续按独立媒体容器及本机文件读取。轨道和画面变换见[通用媒体 API](../docs/apis/compute.md#通用媒体处理)，4K 和其他规格共用上述文件及磁盘限制。

每步先写启动意图、再写 PID 和进程身份，等进程结束后保存退出结果并核验输出摘要。未知进程在相应类别保持 HOLD。人工已经按前文确认未落 PID 的媒体进程终止后，可执行 `node compute/dist/main.js resolve-media-no-pid <attempt-id> --confirmed-process-terminated '<确认依据>'`，与单路转码使用各自的 journal 记录。

已持久化的产物和 manifest 使用同一 attempt 前缀并在每次 PUT 显式设置 `private` ACL。每次 PUT 前记录意图。结果未知时按原对象键核验长度、ETag 和真实字节 SHA-256。旧键仍缺失时保持待对账，保留本地文件。publish confirm 后标记结果确认，再 ACK 命令。连接中断时待槽 attempt 保留为已接收，重新连接后可继续接纳取消，并让原命令在同一次 attempt 中重投。

正在等待输出恢复槽的任务收到取消后，只取消自己的等待。未确定的旧 PUT 仍须按原对象键对账。抽帧与音频重封装按实际画面流寻找末尾，流时长缺失时可逐包扫描时间戳。末帧尾窗无法产出时逐帧解码并只保留最后一张图。

## Worker 观测与调限

部署先在 A 侧迁移 PostgreSQL 并预置实例队列。B 的 `MIO_COMPUTE_INSTANCE_ID` 需在部署允许清单 `MIO_COMPUTE_WORKER_INSTANCE_IDS` 内才接入观测与动态控制。沿用旧 SQLite 就地升级，复用稳定卷和实例身份。B 的 `MIO_COMPUTE_HARD_MAX_TOTAL`、`MIO_COMPUTE_HARD_MAX_ENCODE`、`MIO_COMPUTE_HARD_MAX_PROBE` 默认为 2/1/1，也是最低部署值。已有保存配置在重启时夹到当前硬限，revision 保留；默认运行限额从 2/1/1 起始。各计算通道使用有限的本地待槽，HOLD 优先于调高，降限不终止运行任务。

B 的遥测每 5 秒采样，真实阶段与占槽变化另记，未确认出箱最多 100000 条且正文合计不超过 256 MiB。触及容量时仅淘汰未确认遥测并上报缺口，保留控制结果和在途发布。Broker 确认后立即回收正文页，只保留消息身份与确认时间 24 小时。丢失和写入故障可见，脱离业务恢复与 FFmpeg 重投。参考[运维 API](../docs/apis/compute-ops.md)和[RabbitMQ 契约](../docs/integrations/rabbitmq.md)。
