# AGENTS.md — GitHub Actions

## OPL fork

For `gaofeng21cn/opl-dsh`, `main` is the sole long-lived development and release branch. Fetch official changes from `upstream/master`; do not maintain an `origin/master` mirror. [Fork maintenance](FORK-MAINTENANCE.md) owns the enabled Actions inventory and update procedure. OPL CI runs on standard GitHub-hosted runners for `main` pushes and pull requests. Windows packaging and native-addon checks retain their path filters. Real-provider tests are manual. Upstream publishing, enterprise-runner, and governance workflows are disabled in this fork; npm/PyPI publishing jobs also enforce the upstream repository identity. Do not enable them when syncing upstream. Always specify `--repo gaofeng21cn/opl-dsh` in `gh` repository commands.

## Preserved upstream workflow design

The following describes the retained upstream workflow files; it does not select the active OPL workflows.

Run jobs on Windows runners (`windows-*` labels) under native `pwsh`. Native Windows build and process checks contribute to the pull-request `all checks passed` verdict; Wine runs Windows Node on hosted Linux only in `ci-master.yml`. Python runtime CI checks Linux/Windows x64 on pull requests and Linux ARM64 plus both macOS architectures on master pushes; releases retain all five targets ([platform policy](../.agents/notes/implemented/process/2026-09-06-master-only-platform-ci.md)). `ci.yml` is pull-request-only. Master-only platform checks, Linux/Windows self-hosted standbys, and manual runner benchmarks live in `ci-master.yml`, which listens to master pushes and `workflow_dispatch`, not `pull_request`; separating workflow triggers keeps master-only jobs out of PR check panels. The master standbys validate the self-hosted failover targets; preserve the existing per-platform switches (values `selfhosted` for the in-house standbys and `blacksmith` for Blacksmith's hosted runners) and the Dependabot hosted fallback under the `selfhosted` values ([failover runbook](../.agents/notes/implemented/process/2026-07-26-ci-failover-runbook.md), [blacksmith failover leg note](../.agents/notes/implemented/process/2026-09-09-blacksmith-failover-leg.md)).
