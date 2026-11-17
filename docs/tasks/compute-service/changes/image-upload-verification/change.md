# 图片上传完整性与对象关联

```mio-change
{"version":1,"type":"adjustment","section":"本期验收与延期项"}
```

图片物化原先在成功 PUT 与 HEAD 后再 GET 全量对象并重算 SHA-256。本次保留本地格式和内容校验、上传完整性及对象身份关联，避免成功路径再下载图片。

## 范围与方案

保留图片签名与完整解码校验、本地 SHA-256、Base64 Content-MD5、流式 PUT、唯一 fileId 和禁止覆盖头。COS 按 Content-MD5 核对提交内容；仅当 PUT 成功且返回 ETag，HEAD 的长度、SHA-256 元数据和 ETag 均匹配本次 PUT，才返回结果。HEAD 不重算内容 SHA-256，ETag 仅作为对象标识。超时或未知写入保持原身份以供对账，重新物化使用新键。视频上传与未知上传恢复的完整 GET 校验不变，结果字段与元数据不变。

## 验收

定向测试覆盖 PNG、JPEG、WebP 成功且无 GET、本地坏数据无 PUT、PUT 失败或缺 ETag、HEAD 缺失或长度／摘要元数据／ETag 不匹配，以及取消、晚到写入和新键隔离；视频恢复的内容校验继续通过。取得覆盖 `pnpm check` 的有效结论、质量和规范审阅；在明确授权的目标桶使用独立 B 身份，另行观察正确和错误 Content-MD5、HEAD 及独立下载审计。自动替身不能证明真实 COS 行为。本候选未接受前不改写[原成果](../../complete/report.md)。

目标桶取得本次写入明确授权后，可在受控环境配置独立 B 凭据、桶和地域，并单独设置 `MIO_IMAGE_UPLOAD_TEST_BUCKET` 为已核验的目标桶；以 `MIO_RUN_IMAGE_UPLOAD_COS_PROBE=yes node tests/compute/live-image-upload-probe.ts` 显式运行。探针生成两个唯一对象键，把动作、键和结果保存到本地 `.runtime/image-upload-cos-probe/`；不删除对象，不自动重试未知写入。执行前须核对目标桶和写入权限，探针开关与目标匹配本身不能证明授权。
