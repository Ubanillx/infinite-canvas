# 无限画布文档索引

## 项目介绍

- [快速开始](/zh-CN/docs/overview/quick-start)
- [Codex App 插件](/zh-CN/docs/overview/codex-app-plugin)
- [功能介绍](/zh-CN/docs/overview/features)
- [Render 部署](/zh-CN/docs/overview/render)
- [Docker 部署](/zh-CN/docs/overview/docker)
- [Jenkins 自动部署](/zh-CN/docs/overview/jenkins)
- [第三方提示词来源](/zh-CN/docs/overview/third-party-prompt-repositories)

## 操作手册

- [画布节点操作手册](/zh-CN/docs/canvas/canvas-node-manual)
- [画布快捷键](/zh-CN/docs/canvas/canvas-shortcuts)

## 开发与数据

- [本地开发](/zh-CN/docs/development/local-development)
- [开发调试与测试工具](/zh-CN/docs/development/debug-tooling)
- [画布数据结构](/zh-CN/docs/development/canvas-data-structure)
- [本地 Codex 连接画布原理](/zh-CN/docs/development/local-codex-canvas)
- [界面设计规范](/zh-CN/docs/development/theme-system)

## 商务合作

- [开源协议](/zh-CN/docs/business/license)
- [商务合作](/zh-CN/docs/business/business)

## 支持与安全

- [漏洞提交](/zh-CN/docs/support/security)
- [赞助支持](/zh-CN/docs/support/sponsor)

## 项目进度

- [更新日志](/zh-CN/docs/progress/changelog)
- [本地 Agent 接入规划](/zh-CN/docs/progress/local-agent-integration-plan)
- [提示词面板引用显示图片缩略图规划](/zh-CN/docs/progress/prompt-chip-input-plan)
- [画布模板规划](/zh-CN/docs/progress/canvas-template-plan)
- [画布媒体引用与安全垃圾回收规划](/zh-CN/docs/progress/canvas-media-lifecycle-plan)
- [待测试](/zh-CN/docs/progress/pending-test)
- [TODO](/zh-CN/docs/progress/todo)

## 说明

- 应用需要 PostgreSQL 与 S3 兼容对象存储（默认 RustFS）；画布、素材和记录按工作区在服务器保存，浏览器只保留缓存。
- AI API Key 由服务器托管，浏览器使用认证同源代理；配置导出与工作区快照不包含服务器密钥。
- 提示词来源由服务端拉取并缓存；WebDAV 仅手动上传和选择导入快照。
