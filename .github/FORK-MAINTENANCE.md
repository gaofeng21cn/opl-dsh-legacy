# OPL DSH 仓库维护

本仓库是独立维护的 DSH fork。`origin` 指向 `gaofeng21cn/opl-dsh`，`upstream` 指向 `deepseek-ai/deepseek-harness`。开发、合并和 OPL 发布均以 `origin/main` 为准；官方更新从 `upstream/master` 获取，不维护额外的 `origin/master` 镜像。

## 同步上游

在干净的独立工作目录中执行：

```sh
git fetch origin main
git fetch upstream master
git switch -c sync/dsh-upstream origin/main
git merge upstream/master
```

解决冲突时保留 OPL 插件、应用标识、独立发布目标和下列工作流策略。按改动范围运行检查，验证后将集成分支合入 `main`。不直接覆盖 `main`，不向官方仓库推送。同步后检查 GitHub Actions 是否引入了新的上游工作流；下表之外的流程在确认适用前保持停用。

GitHub CLI 在 fork 中可能默认选择官方仓库，因此每次都显式指定目标，例如：

```sh
gh run list --repo gaofeng21cn/opl-dsh
gh api repos/gaofeng21cn/opl-dsh/actions/workflows --jq '.workflows[] | {name, path, state}'
```

## OPL 的 GitHub Actions

| 工作流 | 触发方式与用途 |
| --- | --- |
| `opl-ci.yml` | `main` 推送、目标为 `main` 的 PR、手动运行；使用标准 Ubuntu runner 执行完整类型检查和 OPL 插件回归，无需 API 密钥 |
| `windows-desktop.yml` | `main` 和 PR 的相关路径改动、手动运行；验证并构建 Windows 安装包 |
| `node-addon-system.yml` | `main` 和 PR 的原生模块相关路径改动、手动运行；保留跨平台原生检查 |
| `expected-filenames.yml` | 特定文件名的 PR 检查 |
| `e2e.yml` | 仅手动运行真实 DeepSeek API 测试；需要 `DEEPSEEK_API_KEY_EXTERNAL`，缺少密钥时明确失败 |
| `pi-ai-provider-e2e.yml` | 仅手动运行 Azure OpenAI 与 Anthropic 测试；需配置各提供方凭据 |

其余继承工作流在本 fork 的 Actions 设置中停用，源码继续保留以便比较和同步。停用范围包括上游专用 CI/runner 演练、npm/PyPI 发布及其打包流程、上游文档/预览部署、上游组织的 Issue 与加权评审自动化。无需为这些流程复制上游服务账号或 runner。四个上游发布工作流还在源码中限制执行仓库，即使被误启用，也不能从本 fork 发布上游包。

自动检查不等于完整发布验收。修改上游核心或原生运行时需要运行受影响的上游检查；DMG 发布仍须完成 OPL 打包、签名、公证与安装包验证。OPL 发行版使用本仓库的 `opl-*` 标签和 GitHub Release，不通过上游 npm/PyPI 发布工作流分发。

## 分支清理

短期分支合入 `main` 后即可删除。删除分支前确认没有独有提交、没有以它为目标的待合并 PR，也没有活跃工作目录使用它。历史提交由 `main` 和已发布标签保留，不为旧快照长期维护一个可写分支。
