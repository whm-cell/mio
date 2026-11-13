# 腾讯云短信使用契约

## 适用范围与接入事实

手机号验证码由[认证插件](../../src/auth/phone.ts)调用[短信适配器](../../src/integrations/tencent-sms.ts)，使用腾讯云 `SendSms` 2021-01-11 和固定版本 `tencentcloud-sdk-nodejs-sms 4.1.306`；依赖树由锁文件固定。只向服务端配置的已审核应用、签名和模板发送大陆号码，模板参数依次为验证码和有效分钟数 `5`。供应商接受请求不证明用户已收到短信。

## 必须遵守的约束

凭据、应用和模板配置仅在服务端持有，不能写入仓库或响应。适配器固定发送一个号码，验证唯一状态码 `Ok`，以 5 秒 AbortSignal 限制请求和读取响应；不自动重试。SDK 默认跟随重定向，每次发送因此使用独立 HTTPS Agent，关闭连接复用并拒绝第二次建连，避免转发含验证码的请求正文。固定短信域名直连，不支持 SDK 隐式 `http_proxy`。拒绝、重定向、超时、断连或无法判断响应均脱敏失败，可能已经产生费用或实际送达。不会把供应商原始异常、手机号或验证码写入日志。

验证码的生成、用途、消费、持久预算和 HTTP 行为由[认证底座](../auth.md)与[认证 HTTP 契约](../apis/auth.md)维护。短信 SDK 仅由此适配器导入，模块边界见[源码护栏](../engineering/source-guardrails.md)。

## 验证入口与变更影响

[适配器测试](../../tests/integrations/tencent-sms.test.ts)核对请求形状、脱敏失败和真实 SDK 对隔离本地 TLS 服务的发送、重定向、并发及响应体中止；[认证测试](../../tests/auth/phone.test.ts)通过受控发送替身和真实隔离 PostgreSQL／HTTP 核对业务行为。它们不能证明应用、签名、模板已审核或实际短信送达；真实供应商验证另行记录。SDK、模板参数或传输策略变化需重验发送、错误、超时与不重发语义。

TLS 测试需要系统 `openssl` 生成一次性证书，测试结束后删除自己的证书和私钥；缺少该命令时明确失败，不跳过用例。

上游参考：[发送短信 API](https://cloud.tencent.com/document/product/382/55981)、[Node.js SDK](https://cloud.tencent.com/document/product/494/7247)。
