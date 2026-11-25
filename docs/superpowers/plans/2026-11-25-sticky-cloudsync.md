# 粘滞与每日云备份 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 修正两次失败切换和每日备份。
**Architecture:** 路由RAII终态守卫；CloudSync持久日历策略与兼容历史存储。
**Tech Stack:** Rust/Tokio/SQLite/React。
**Spec:** 2026-11-25-sticky-cloudsync-design.md

## Global Constraints
保持3.5.1，只同步beta，不tag；现有生产数据、密钥协议、权限不变。

## Review Focus
显式取消不惩罚；迟到完成不污染新generation；账号同数量替换仍上传；失败不得推进成功状态；清理不碰非日期/其他profile对象。

### Task 1: Routing lifecycle
Files: server/core/route_health,route_state,rotate,route_content,route_completion,provider_loop and scripts/test-sticky-failover.mjs（现有模块实际路径）。
- [x] 真实HTTP旧程序复现五个跨请求失败。
- [x] RAII处理首内容前、hold中、首内容后Drop；严格和自动粘滞首次失败换同渠道账号。
- [x] 统一Cargo编译后跑五场景与现有路由回归。

### Task 2: CloudSync schedule and history
Files: desktop-tauri/src-tauri/server/src/server/core/cloud_sync/{auto_sync,settings,mod,transport,webdav,s3,snapshot}.rs and new policy.rs.
- [x] 读取真实snapshot/transport接口。
- [x] 对真实调度决策写日内、跨日、新账号、重启、失败和scope回归并确认RED。
- [x] 实现持久upload日/账号集合、定时唤醒、失败退避；修正下载hash。
- [x] DAV/S3每日目录上传与超过七日清理，latest兼容、manifest最后提交。
- [x] 跑Cargo单元与HTTP DAV/S3协议验收。

### Task 3: UI
Files: mobile/src/{App.tsx,pages/MorePage.tsx}、桌面Agent导航与settings-cloud-sync。
- [x] 移除Agent配置入口/路由，保留共享后端。
- [x] 更新自动备份说明；构建两前端并实际检查导航。

### Task 4: Review and deploy
- [x] 独立review全部diff，修复发现；未发送正常错误返回补齐dispatch门，最终533项库测试及29项HTTP路由验收通过。
- [x] 保存本批六条实际更新日志、测试证据与部署边界。
- [ ] 展示日志并按AGENTS.md/release-flow取得本批确认，之后提交推送origin/beta。
- [ ] 执行固定digest部署，保留最近一份回退。
- [ ] 生产健康、源码revision、数据和UI验收。
